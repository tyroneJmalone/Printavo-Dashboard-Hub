import { test } from "node:test";
import assert from "node:assert/strict";
import { shippingProgress, type ShippingPricedItem } from "../../hub/src/components/purchasing/shippingProgress";
import { SetVendorShippingTermsBody } from "@workspace/api-zod";
import type { VendorShippingTerms } from "@workspace/api-client-react";

// Deliberately fictional contract: never written to the application settings.
const terms: VendorShippingTerms = {
  accountLabel: "Test fixture only", threshold: 100, scope: "order",
  shippingMethod: "", excludedBrands: [], excludedStyles: [], otherConditions: "",
  evidence: "Synthetic test fixture", verifiedOn: "2026-01-01", validThrough: "2026-12-31",
};
const now = Date.parse("2026-10-10T12:00:00Z");
const item = (overrides: Partial<ShippingPricedItem> = {}): ShippingPricedItem => ({
  key: "line", vendor: "sanmar", styleNumber: "TEST", vendorStyleNumber: "TEST",
  shippingVendorBrand: "Test Brand", brand: "Test Brand", resolved: true,
  sizes: [{ size: "M", qty: 5, unitCost: 10 }],
  ...overrides,
} as ShippingPricedItem);
const run = (items = [item()], contract: VendorShippingTerms | null = terms, selected = new Set(["line"])) =>
  shippingProgress(items, selected, "sanmar", contract, now);

test("no fabricated default; only selected quantities for the matching vendor count", () => {
  assert.equal(run(undefined, null), null);
  assert.equal(run()!.remaining, 50);
  assert.equal(run([item({ key: "unselected" }), item({ vendor: "ss" }), item()])!.amount, 50);
  assert.equal(run()!.percent, 50);
});
test("zero price is resolved; unpriced/unresolved/invalid quantities never establish eligibility", () => {
  for (const bad of [null, NaN, -1]) {
    const result = run([item({ sizes: [{ size: "M", qty: 10, unitCost: bad }] as ShippingPricedItem["sizes"] })])!;
    assert.equal(result.amount, 0);
    assert.equal(result.incomplete, true);
    assert.equal(result.estimatedEligible, false);
  }
  assert.equal(run([item({ resolved: false })])!.amount, 0);
  assert.equal(run([item({ sizes: [{ size: "M", qty: -2, unitCost: 10 }] as ShippingPricedItem["sizes"] })])!.incomplete, true);
  assert.equal(run([item({ sizes: [{ size: "M", qty: 1, unitCost: 0 }] as ShippingPricedItem["sizes"] })])!.incomplete, false);
});
test("exact threshold and excess remain estimates, never negative remaining", () => {
  const result = run([item({ sizes: [{ size: "M", qty: 10, unitCost: 10 }] as ShippingPricedItem["sizes"] })])!;
  assert.equal(result.estimatedEligible, true);
  assert.equal(result.remaining, 0);
  assert.equal(run(undefined, { ...terms, threshold: 0 })!.percent, 100);
});
test("exclusions use resolved vendor identity and normalize whitespace/case, not substring matching", () => {
  assert.equal(run(undefined, { ...terms, excludedBrands: ["  TEST   Brand "] })!.excludedLines, 1);
  assert.equal(run(undefined, { ...terms, excludedStyles: [" test "] })!.excludedLines, 1);
  assert.equal(run(undefined, { ...terms, excludedBrands: ["Test"] })!.amount, 50);
  assert.equal(run([item({ brand: "Nonexcluded", shippingVendorBrand: "Test Brand" })], { ...terms, excludedBrands: ["Test Brand"] })!.amount, 0);
  assert.equal(run([item({ shippingVendorBrand: null })], { ...terms, excludedBrands: ["Test Brand"] })!.incomplete, true);
});
test("expired terms, unknown warehouse splits, methods and other restrictions fail closed", () => {
  for (const restriction of [{ scope: "warehouse" as const }, { shippingMethod: "Ground" },
    { otherConditions: "Continental US only" }, { validThrough: "2026-10-09" }]) {
    const result = run(undefined, { ...terms, threshold: 1, ...restriction })!;
    assert.equal(result.estimatedEligible, false);
    assert.ok(result.blockers.length);
  }
});
test("incomplete selection stays unresolved even when its known portion exceeds threshold", () => {
  const result = run([item(), item({ key: "missing", resolved: false })],
    { ...terms, threshold: 1 }, new Set(["line", "missing"]))!;
  assert.equal(result.amount, 50);
  assert.equal(result.estimatedEligible, false);
});
test("API contract accepts explicit clear and rejects negative/missing terms", () => {
  assert.ok(SetVendorShippingTermsBody.safeParse({ terms, adminPin: "test-only", confirmed: true }).success);
  assert.ok(SetVendorShippingTermsBody.safeParse({ terms: null, adminPin: "test-only", confirmed: true }).success);
  assert.equal(SetVendorShippingTermsBody.safeParse({ terms: { ...terms, threshold: -1 }, adminPin: "test-only", confirmed: true }).success, false);
  assert.equal(SetVendorShippingTermsBody.safeParse({ terms, confirmed: true }).success, false);
});
