import assert from "node:assert/strict";
import test from "node:test";
import { SSApiError, SSClient } from "@workspace/ss-activewear";
import { vendorLookup } from "../src/lib/purchasing/vendorLookup";

const credentials = { accountNumber: "test-account", apiKey: "test-key" };

function sanMarProductResponse(
  style: string,
  {
    brand = "CornerStone",
    title = "ANSI 107 Class 2 Mesh Zippered Vest",
    color = "SftyYellow",
  }: { brand?: string; title?: string; color?: string } = {},
): string {
  return `<listResponse>
    <productBasicInfo>
      <style>${style}</style>
      <catalogColor>${color}</catalogColor>
      <size>S/M</size>
      <sizeIndex>1</sizeIndex>
      <inventoryKey>inventory-${style}</inventoryKey>
      <brandName>${brand}</brandName>
      <productTitle>${title}</productTitle>
    </productBasicInfo>
    <productPriceInfo>
      <piecePrice>19.62</piecePrice>
      <casePrice>17.62</casePrice>
    </productPriceInfo>
  </listResponse>`;
}

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

test("SanMar lookup prioritizes the exact alphanumeric style across case and prose prefixes", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.SANMAR_ACCOUNT_NUMBER;
  const originalUsername = process.env.SANMAR_USERNAME;
  const originalPassword = process.env.SANMAR_PASSWORD;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.SANMAR_ACCOUNT_NUMBER;
    else process.env.SANMAR_ACCOUNT_NUMBER = originalAccount;
    if (originalUsername === undefined) delete process.env.SANMAR_USERNAME;
    else process.env.SANMAR_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.SANMAR_PASSWORD;
    else process.env.SANMAR_PASSWORD = originalPassword;
  });
  process.env.SANMAR_ACCOUNT_NUMBER = "test-account";
  process.env.SANMAR_USERNAME = "test-user";
  process.env.SANMAR_PASSWORD = "test-password";

  const attempted: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = String(init?.body ?? "");
    const style = body.match(/<style>([^<]*)<\/style>/)?.[1] ?? "";
    attempted.push(style);
    return new Response(
      style.toLowerCase() === "csv102" ? sanMarProductResponse("CSV102") : "",
      { status: 200, headers: { "content-type": "text/xml" } },
    );
  };

  const lower = await vendorLookup("sanmar", "csv102", { brandHint: "cornerstone" });
  assert.equal(lower.styleName, "CSV102");
  assert.equal(lower.matchType, "exact");
  assert.equal(lower.colors[0]?.sizes[0]?.cost, 17.62, "SanMar cost must remain casePrice");

  const prefixed = await vendorLookup("sanmar", "SAFETY VEST CSV102", {
    brandHint: "CornerStone",
    descriptionHint: "ANSI 107 Class 2 Mesh Zippered Vest",
  });
  assert.equal(prefixed.styleName, "CSV102");
  assert.equal(prefixed.matchType, "exact");
  assert.deepEqual(
    attempted.slice(-2).map((value) => value.toLowerCase()),
    ["safety vest csv102", "csv102"],
    "the full query must fall back to CSV102 before any degraded numeric candidate",
  );
  assert.equal(attempted.some((value) => value === "102"), false);

  const wrongBrand = await vendorLookup("sanmar", "CSV102", { brandHint: "Different Brand" });
  assert.equal(wrongBrand.styleName, "CSV102");
  assert.equal(wrongBrand.matchType, "closest", "a conflicting Printavo brand must remain visible");

  const vagueBrand = await vendorLookup("sanmar", "CSV102", { brandHint: "Corner" });
  assert.equal(vagueBrand.styleName, "CSV102");
  assert.equal(vagueBrand.matchType, "closest", "a partial brand fragment must not count as a match");
});

test("SanMar lookup tries a known brand prefix before a bare numeric style", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.SANMAR_ACCOUNT_NUMBER;
  const originalUsername = process.env.SANMAR_USERNAME;
  const originalPassword = process.env.SANMAR_PASSWORD;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.SANMAR_ACCOUNT_NUMBER;
    else process.env.SANMAR_ACCOUNT_NUMBER = originalAccount;
    if (originalUsername === undefined) delete process.env.SANMAR_USERNAME;
    else process.env.SANMAR_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.SANMAR_PASSWORD;
    else process.env.SANMAR_PASSWORD = originalPassword;
  });
  process.env.SANMAR_ACCOUNT_NUMBER = "test-account";
  process.env.SANMAR_USERNAME = "test-user";
  process.env.SANMAR_PASSWORD = "test-password";

  const attempted: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = String(init?.body ?? "");
    const style = body.match(/<style>([^<]*)<\/style>/)?.[1] ?? "";
    attempted.push(style);
    if (style.toLowerCase() === "bc3001") {
      return new Response(
        sanMarProductResponse("BC3001", {
          brand: "BELLA + CANVAS",
          title: "Unisex Jersey Short Sleeve Tee",
        }),
        { status: 200, headers: { "content-type": "text/xml" } },
      );
    }
    if (style === "3001") {
      return new Response(
        sanMarProductResponse("3001", { brand: "Gildan", title: "Different Tee" }),
        { status: 200, headers: { "content-type": "text/xml" } },
      );
    }
    return new Response("", { status: 200, headers: { "content-type": "text/xml" } });
  };

  const result = await vendorLookup("sanmar", "bella 3001", {
    brandHint: "BELLA + CANVAS",
  });
  assert.equal(result.styleName, "BC3001");
  assert.equal(result.brand, "BELLA + CANVAS");
  assert.equal(result.matchType, "exact");
  assert.deepEqual(
    attempted.map((value) => value.toLowerCase()),
    ["bella 3001", "bc3001"],
    "BC3001 must resolve before the ambiguous bare 3001 candidate",
  );
});

test("SanMar lookup rejects a vendor response for a different style", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.SANMAR_ACCOUNT_NUMBER;
  const originalUsername = process.env.SANMAR_USERNAME;
  const originalPassword = process.env.SANMAR_PASSWORD;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.SANMAR_ACCOUNT_NUMBER;
    else process.env.SANMAR_ACCOUNT_NUMBER = originalAccount;
    if (originalUsername === undefined) delete process.env.SANMAR_USERNAME;
    else process.env.SANMAR_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.SANMAR_PASSWORD;
    else process.env.SANMAR_PASSWORD = originalPassword;
  });
  process.env.SANMAR_ACCOUNT_NUMBER = "test-account";
  process.env.SANMAR_USERNAME = "test-user";
  process.env.SANMAR_PASSWORD = "test-password";

  globalThis.fetch = async () =>
    new Response(sanMarProductResponse("CSV106"), {
      status: 200,
      headers: { "content-type": "text/xml" },
    });

  const result = await vendorLookup("sanmar", "DESCRIPTIVE CSV102 WRONG-CANDIDATE-GUARD", {
    brandHint: "CornerStone",
  });
  assert.equal(result.found, false);
  assert.equal(result.matchType, "none");
  assert.equal(result.styleName, null);
  assert.deepEqual(result.colors, []);
});