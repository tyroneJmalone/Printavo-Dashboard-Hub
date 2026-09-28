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

test("SanMar Bella lookup tries the original code first but rejects another brand before prefix fallback", async (t) => {
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
    ["bella 3001", "3001", "bc3001"],
    "Try the original style first; the wrong-brand response must not suppress BC3001",
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

test("Next Level 6210M resolves to SanMar NL6210 without changing vendor", async (t) => {
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
    const style = String(init?.body ?? "").match(/<style>([^<]*)<\/style>/)?.[1] ?? "";
    attempted.push(style);
    return new Response(
      style.toLowerCase() === "nl6210"
        ? sanMarProductResponse("NL6210", {
            brand: "Next Level Apparel",
            title: "Unisex CVC Tee",
          })
        : "",
      { status: 200, headers: { "content-type": "text/xml" } },
    );
  };

  const result = await vendorLookup("sanmar", "6210M", { brandHint: "Next Level" });
  assert.equal(result.vendor, "sanmar");
  assert.equal(result.styleName, "NL6210");
  assert.equal(result.matchType, "exact");
  assert.equal(result.colors[0]?.sizes[0]?.cost, 17.62, "casePrice remains the cost");
  assert.deepEqual(attempted.map((value) => value.toLowerCase()), ["6210m", "nl6210"]);
});

test("Next Level NL6210 resolves to S&S 6210 while conflicting brands stay closest", async (t) => {
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

  const searched: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/styles/")) {
      const term = url.searchParams.get("search") ?? "";
      searched.push(term);
      return new Response(
        JSON.stringify(
          term === "6210"
            ? [{
                styleID: 6210,
                styleName: "6210",
                brandName: "Next Level Apparel",
                title: "Unisex CVC Tee",
                styleImage: null,
              }]
            : [],
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify([{
        sku: "6210-BLACK-M",
        colorName: "Black",
        sizeName: "M",
        piecePrice: 4.5,
        salePrice: null,
        customerPrice: null,
        saleExpiration: null,
        qty: 12,
        warehouses: [],
      }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const exact = await vendorLookup("ss", "NL6210", { brandHint: "Next Level" });
  assert.equal(exact.vendor, "ss");
  assert.equal(exact.styleName, "6210");
  assert.equal(exact.matchType, "exact");
  assert.deepEqual(searched, ["NL6210", "6210"], "alias fallback stays within two searches");

  const conflicting = await vendorLookup("ss", "6210M", { brandHint: "Different Brand" });
  assert.equal(conflicting.styleName, "6210");
  assert.equal(conflicting.matchType, "closest");
  const conflictingLiteral = await vendorLookup("ss", "6210", {
    brandHint: "Different Brand",
  });
  assert.equal(
    conflictingLiteral.matchType,
    "closest",
    "literal style alone cannot override a conflicting brand",
  );
  assert.ok(searched.length <= 5, "conflicting-brand fallback remains bounded");
});

test("American Apparel 102A surfaces S&S style 102 as review-required, never equivalent", async (t) => {
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

  const searched: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/styles/")) {
      const term = url.searchParams.get("search") ?? "";
      searched.push(term);
      const result =
        term === "102"
          ? [{
              styleID: 11184,
              styleName: "102",
              brandName: "American Apparel",
              title: "Women's Fine Jersey Mid-Length Boxy Tee",
              styleImage: null,
            }]
          : term === "102A"
            ? [{
                styleID: 13996,
                styleName: "102A",
                brandName: "Threadfast Apparel",
                title: "Unisex Triblend T-Shirt",
                styleImage: null,
              }]
            : [];
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify([{
      sku: "AA102-BLACK-M",
      colorName: "Black",
      sizeName: "M",
      piecePrice: 4.75,
      salePrice: null,
      customerPrice: null,
      saleExpiration: null,
      qty: 20,
      warehouses: [],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };

  const corrected = await vendorLookup("ss", "102A", { brandHint: "American Apparel" });
  assert.equal(corrected.styleName, "102");
  assert.equal(corrected.brand, "American Apparel");
  assert.equal(
    corrected.matchType,
    "closest",
    "brand plus a stripped/changed suffix is not evidence of manufacturer equivalence",
  );
  assert.deepEqual(searched, ["102"], "confirmed alias must bypass Threadfast's literal 102A");

  const threadfast = await vendorLookup("ss", "102A", { brandHint: "Threadfast Apparel" });
  assert.equal(threadfast.styleName, "102A");
  assert.equal(threadfast.brand, "Threadfast Apparel");
  assert.equal(threadfast.matchType, "exact");
  assert.deepEqual(searched, ["102", "102A"], "conflicting brand must retain the literal style");
});

test("American Apparel 307 resolves to canonical S&S 307GD with selectable Faded Powder Pink", async (t) => {
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

  const searched: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/styles/")) {
      const term = url.searchParams.get("search") ?? "";
      searched.push(term);
      return new Response(
        JSON.stringify(
          term.toLowerCase() === "307gd"
            ? [{
                styleID: 11696,
                styleName: "307GD",
                brandName: "American Apparel",
                title: "Women's Heavyweight Cotton Garment-Dyed Muscle Tee",
                styleImage: null,
              }]
            : [],
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    assert.equal(url.searchParams.get("styleid"), "11696");
    return new Response(JSON.stringify([{
      sku: "B03327304",
      colorName: "Faded Powder Pink",
      sizeName: "M",
      piecePrice: 6.04,
      salePrice: 5.27,
      customerPrice: 5.27,
      saleExpiration: "2026-09-24T00:00:00",
      qty: 0,
      warehouses: [{ warehouseAbbr: "PA", qty: 0 }],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await vendorLookup("ss", "307", { brandHint: "American Apparel" });
  assert.equal(result.styleId, "11696");
  assert.equal(result.styleName, "307GD");
  assert.equal(result.brand, "American Apparel");
  assert.equal(result.matchType, "exact", "the shop explicitly confirmed 307 = 307GD");
  assert.equal(result.colors[0]?.colorName, "Faded Powder Pink");
  assert.equal(result.colors[0]?.sizes[0]?.sku, "B03327304");
  assert.deepEqual(
    searched.map((value) => value.toLowerCase()),
    ["307", "307gd"],
    "the literal lookup must fall back to only the bounded canonical alias",
  );
});
