import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMappingSource, verifiedMappingTarget } from "../src/lib/purchasing/approvedMappingPolicy";
import type { VendorLookupResult } from "../src/lib/purchasing/vendorLookup";

const offer: VendorLookupResult = {
  found: true, matchType: "exact", vendor: "ss", styleQueried: "3001",
  styleId: "42", styleName: "3001", brand: "Bella", title: null,
  styleImage: null, cached: false, fetchedAt: new Date().toISOString(),
  colors: [{ colorName: "Heather Navy", swatchImage: null, productImage: null, sizes: [] }],
};
const input = { vendor: "ss", vendorStyleId: "42", vendorStyle: "3001", vendorColor: "Heather Navy" };

test("source normalization preserves exact colors, brands and style punctuation", () => {
  assert.equal(normalizeMappingSource("  HEATHER   Navy "), "heather navy");
  assert.notEqual(normalizeMappingSource("Navy"), normalizeMappingSource("Heather Navy"));
  assert.notEqual(normalizeMappingSource("PC-54"), normalizeMappingSource("PC54"));
  assert.notEqual(normalizeMappingSource("Bella"), normalizeMappingSource("Gildan"));
});
test("only selected style identity and actual vendor color are approved", () => {
  assert.deepEqual(verifiedMappingTarget(input, offer), {
    vendorStyleId: "42", vendorStyle: "3001", vendorColor: "Heather Navy",
  });
  for (const change of [
    { vendorStyleId: "43" }, { vendorStyleId: null }, { vendorStyle: "3001CVC" },
    { vendorColor: "Navy" }, { vendorColor: "heather navy" }, { vendor: "sanmar" },
  ]) assert.equal(verifiedMappingTarget({ ...input, ...change }, offer), null);
  assert.equal(verifiedMappingTarget(input, { ...offer, found: false }), null);
});
test("SanMar uses null style ID but still requires exact style and color", () => {
  const sanmar = { ...offer, vendor: "sanmar" as const, styleId: null, styleName: "PC54" };
  assert.ok(verifiedMappingTarget({ ...input, vendor: "sanmar", vendorStyleId: null, vendorStyle: "pc54" }, sanmar));
  assert.equal(verifiedMappingTarget({ ...input, vendor: "sanmar", vendorStyleId: "42", vendorStyle: "pc54" }, sanmar), null);
});