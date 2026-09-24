import assert from "node:assert/strict";
import test from "node:test";
import { SSApiError, SSClient } from "@workspace/ss-activewear";
import { vendorLookup } from "../src/lib/purchasing/vendorLookup";

const credentials = { accountNumber: "test-account", apiKey: "test-key" };

test("S&S product pricing preserves piecePrice baseline and dated sale fields", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        {
          sku: "SKU-1",
          colorName: "Black",
          sizeName: "M",
          piecePrice: 4.49,
          salePrice: 4.14,
          customerPrice: 4.14,
          saleExpiration: "2026-09-23T00:00:00",
          qty: 8,
          warehouses: [{ warehouseAbbr: "IL", qty: 8 }],
        },
        {
          sku: "SKU-2",
          colorName: "Black",
          sizeName: "L",
          piecePrice: null,
          salePrice: null,
          customerPrice: null,
          saleExpiration: null,
          qty: 0,
          warehouses: [],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const products = await new SSClient(credentials).getProducts(29);
  assert.equal(products[0]?.piecePrice, 4.49);
  assert.equal(products[0]?.salePrice, 4.14);
  assert.equal(products[0]?.customerPrice, 4.14);
  assert.equal(products[0]?.saleExpiration, "2026-09-23T00:00:00");
  assert.equal(products[1]?.piecePrice, null, "missing regular price must not become $0");
  assert.equal(products[1]?.salePrice, null, "missing sale price must not become $0");
});

test("vendor lookup exposes piecePrice as cost and only keeps a dated lower sale", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.SS_ACCOUNT_NUMBER;
  const originalKey = process.env.SS_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.SS_ACCOUNT_NUMBER;
    else process.env.SS_ACCOUNT_NUMBER = originalAccount;
    if (originalKey === undefined) delete process.env.SS_API_KEY;
    else process.env.SS_API_KEY = originalKey;
  });
  process.env.SS_ACCOUNT_NUMBER = credentials.accountNumber;
  process.env.SS_API_KEY = credentials.apiKey;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/styles/")) {
      return new Response(
        JSON.stringify([
          {
            styleID: 29001,
            styleName: "TEST29001",
            brandName: "Test Brand",
            title: "Test Tee",
            styleImage: null,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify([
        {
          sku: "SKU-LOOKUP",
          colorName: "Black",
          sizeName: "M",
          piecePrice: 4.49,
          salePrice: 4.14,
          customerPrice: 4.14,
          saleExpiration: "2026-09-23T00:00:00",
          qty: 8,
          warehouses: [],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await vendorLookup("ss", "TEST29001");
  const offer = result.colors[0]?.sizes[0];
  assert.equal(offer?.cost, 4.49);
  assert.equal(offer?.salePrice, 4.14);
  assert.equal(offer?.saleEndsAt, "2026-09-23T00:00:00");
});

test("S&S read-only catalog GET retries one transient failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("temporary", { status: 503 })
      : new Response(
          JSON.stringify([
            {
              styleID: 29,
              styleName: "3001",
              brandName: "BELLA + CANVAS",
              title: "Unisex Jersey Tee",
              styleImage: null,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
  };

  const styles = await new SSClient(credentials).searchStyles("3001");
  assert.equal(calls, 2);
  assert.equal(styles[0]?.styleName, "3001");
});

test("S&S catalog errors are explicit and credential-safe", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "response shape changed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    new SSClient(credentials).getProducts(29),
    (error: unknown) =>
      error instanceof SSApiError &&
      error.message === "S&S returned an unexpected products response" &&
      !error.message.includes(credentials.accountNumber) &&
      !error.message.includes(credentials.apiKey),
  );
});