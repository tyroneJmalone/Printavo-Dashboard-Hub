import test from "node:test";
import assert from "node:assert/strict";
import { SanMarClient, type SanMarProductEntry } from "@workspace/sanmar";
import { SSClient } from "@workspace/ss-activewear";
import { vendorLookup } from "../src/lib/purchasing/vendorLookup";

const row = (style: string, brandName = "Bella + Canvas"): SanMarProductEntry => ({
  style, brandName, productTitle: "Test garment", catalogColor: "Ht Clay", size: "M",
  casePrice: 4.91, piecePrice: 5.91, caseSalePrice: null, pieceSalePrice: null,
  saleEndDate: null, inventoryKey: "test", sizeIndex: 1,
  colorSwatchImage: null, colorProductImage: null,
} as SanMarProductEntry);

test("SanMar Bella prefix preserves identity, exact-first ordering and bounded cached calls", async (t) => {
  const original = SanMarClient.prototype.getProductInfo;
  const originalSS = SSClient.prototype.searchStyles;
  const keys = ["SANMAR_ACCOUNT_NUMBER", "SANMAR_USERNAME", "SANMAR_PASSWORD", "SS_ACCOUNT_NUMBER", "SS_API_KEY"];
  const old = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = "test-only"; });
  const calls: string[] = [];
  let respond: (style: string) => SanMarProductEntry[] = () => [];
  SanMarClient.prototype.getProductInfo = async function (style) {
    calls.push(style.toUpperCase());
    return respond(style.toUpperCase());
  };
  let context = 0;
  const lookup = (style: string, brandHint: string | undefined = "BELLA + CANVAS") =>
    vendorLookup("sanmar", style, { brandHint, descriptionHint: `test ${++context}` });
  try {
    for (const code of ["3001", "3001CVC", "3002CVC", "3413", "3501", "6400CVC", "6004", "7502"]) {
      await t.test(`prefixes full ${code} and caches`, async () => {
        calls.length = 0;
        respond = style => style === `BC${code}` ? [row(style)] : [];
        const hints = { brandHint: "BELLA + CANVAS", descriptionHint: `cache ${code}` };
        const result = await vendorLookup("sanmar", code, hints);
        assert.equal(result.matchType, "exact");
        assert.equal(result.styleName, `BC${code}`);
        assert.equal(result.colors[0]?.sizes[0]?.cost, 4.91);
        assert.deepEqual(calls, [code, `BC${code}`]);
        assert.equal((await vendorLookup("sanmar", code, hints)).cached, true);
        assert.equal(calls.length, 2);
      });
    }
    await t.test("existing unprefixed product wins before prefix", async () => {
      calls.length = 0;
      respond = style => [row(style)];
      assert.equal((await lookup("3001CVC")).styleName, "3001CVC");
      assert.deepEqual(calls, ["3001CVC"]);
    });
    await t.test("already prefixed never doubles or strips, including on miss", async () => {
      for (const found of [true, false]) {
        calls.length = 0;
        respond = style => found ? [row(style)] : [];
        assert.equal((await lookup("bc3001cvc")).found, found);
        assert.deepEqual(calls, ["BC3001CVC"]);
      }
    });
    await t.test("wrong or missing returned brand and wrong returned styles fail closed", async () => {
      for (const product of [row("BC3001CVC", "Other Brand"), row("BC3001CVC", ""), row("BC3001"), row("BC3002CVC")]) {
        calls.length = 0;
        respond = () => [product];
        assert.equal((await lookup("3001CVC")).found, false);
        assert.deepEqual(calls, ["3001CVC", "BC3001CVC"]);
      }
    });
    await t.test("wrong direct brand does not suppress correct prefixed result", async () => {
      calls.length = 0;
      respond = style => [row(style, style === "3001" ? "Gildan" : "BELLA + CANVAS")];
      assert.equal((await lookup("3001")).styleName, "BC3001");
      assert.deepEqual(calls, ["3001", "BC3001"]);
    });
    await t.test("suffix preserved even when stripped product exists", async () => {
      calls.length = 0;
      respond = style => style === "3001" || style === "BC3001" ? [row(style)] : [];
      assert.equal((await lookup("3001CVC")).found, false);
      assert.deepEqual(calls, ["3001CVC", "BC3001CVC"]);
    });
    await t.test("recognized typed and hinted brand variants", async () => {
      respond = style => style === "BC3001CVC" ? [row(style)] : [];
      for (const brand of ["Bella", "Bella + Canvas", "Bella & Canvas", "Bella and Canvas"]) {
        assert.equal((await lookup("3001CVC", brand)).matchType, "exact");
        calls.length = 0;
        const result = await vendorLookup("sanmar", `${brand} 3001CVC`, { descriptionHint: `typed ${++context}` });
        assert.equal(result.matchType, "exact");
        assert.deepEqual(calls.slice(1), ["3001CVC", "BC3001CVC"]);
      }
    });
    await t.test("missing or other input brand cannot synthesize Bella prefix", async () => {
      respond = style => style === "BC3001CVC" ? [row(style)] : [];
      for (const brandHint of ["Gildan", "", "Canvas", "Not Bella"]) {
        calls.length = 0;
        assert.equal((await lookup("3001CVC", brandHint)).found, false);
        assert.ok(!calls.includes("BC3001CVC"));
      }
      calls.length = 0;
      assert.equal((await vendorLookup("sanmar", "3001CVC")).found, false);
      assert.ok(!calls.includes("BC3001CVC"));
      calls.length = 0;
      assert.equal((await lookup("Bella Canvas 3001", "Gildan")).found, false);
      assert.ok(!calls.includes("BC3001"));
    });
    await t.test("other brands retain review-required stripped fallback", async () => {
      calls.length = 0;
      respond = style => style === "7610" ? [row(style, "Next Level")] : [];
      assert.equal((await lookup("7610N", "Next Level")).matchType, "closest");
      assert.deepEqual(calls, ["7610N", "7610"]);
    });
    await t.test("S&S keeps its existing search and stripped fallback, no new BC alias", async () => {
      const searches: string[] = [];
      SSClient.prototype.searchStyles = async function (query) {
        searches.push(query);
        return [];
      };
      assert.equal((await vendorLookup("ss", "3001CVC", { brandHint: "BELLA + CANVAS" })).found, false);
      assert.deepEqual(searches, ["3001CVC", "3001"]);
    });
  } finally {
    SanMarClient.prototype.getProductInfo = original;
    SSClient.prototype.searchStyles = originalSS;
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    });
  }
});