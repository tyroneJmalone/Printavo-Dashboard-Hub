import test from "node:test";
import assert from "node:assert/strict";
import type { PoFile, VendorLookupResult, VendorSizeOffer } from "@workspace/api-client-react";
import { usePoCart, type CartItem } from "../../stores/poCart";
import {
  createQueueLookup, freshLookup, isCurrentPricingRequest, lookupContext, priceQueueItem,
  pricingContext, purchaseCost, purchaseTotal, savedSourceVendor, selectedPurchaseTotals,
  shouldAutoPrice,
  queueSourceVendor, applySelectedQueueVendor,
} from "./queuePricing";

const now = Date.parse("2026-07-10T12:00:00Z");
const size = (label: string, cost: number | null): VendorSizeOffer => ({
  size: label, cost, salePrice: null, saleEndsAt: null, msrp: null,
  sku: `sku-${label}`, inventoryKey: "key", sizeIndex: 1, inventoryTotal: null, warehouses: null,
});
const item: CartItem = {
  key: "line1", printavoLineItemId: "line1", printavoOrderId: "invoice1", visualId: 22251,
  styleNumber: "5000", color: "Black", brand: "Gildan", description: "Tee",
  vendor: "ss", vendorCatalogColor: null, vendorStyleId: null, resolved: false,
  sizes: ["S", "2XL"].map(s => ({ size: s, qty: 2, unitCost: null, sku: null,
    inventoryKey: null, sizeIndex: null, vendorSize: null })),
  inventory: null, warehouseCode: null, warehouseName: null, warehouseManual: false,
};
const response: VendorLookupResult = {
  found: true, matchType: "exact", vendor: "ss", styleQueried: "5000", styleId: "123",
  styleName: "5000", brand: "Gildan", title: "Tee", styleImage: null,
  colors: [{ colorName: "Black", swatchImage: null, productImage: null,
    sizes: [size("S", 3), size("2XL", 5)] }],
  cached: false, fetchedAt: new Date(now).toISOString(),
};

test("explicit approved color keeps source label and exact vendor snapshot", () => {
  const priced = priceQueueItem({ ...item, color: "Customer black" }, response, now,
    { vendorStyleId: "123", vendorStyle: "5000", vendorColor: "Black" });
  assert.equal(priced.color, "Customer black");
  assert.equal(priced.vendorCatalogColor, "Black");
  assert.equal(priced.vendorStyleNumber, "5000");
  assert.equal(priced.sizes[0].sku, "sku-S");
});

test("suggested vendor defaults never replace an explicit choice or cleared choice", () => {
  const suggested = { ...item, brand: "Port & Company" };
  assert.equal(queueSourceVendor(suggested, [], {}), "sanmar");
  assert.equal(queueSourceVendor(suggested, [], { [item.key]: "ss" }), "ss");
  assert.equal(queueSourceVendor(suggested, [], { [item.key]: null }), null);
});

test("bulk assignment includes unresolved styles and colors across invoice selections", () => {
  const lines = [item, { ...item, key: "missing", printavoOrderId: "other", styleNumber: "", color: "Unmatched" },
    { ...item, key: "unselected" }];
  const sources = applySelectedQueueVendor(lines, new Set(["line1", "missing"]), { unselected: "ss" }, "sanmar");
  assert.deepEqual(sources, { line1: "sanmar", missing: "sanmar", unselected: "ss" });
});

test("approved replacement is exact and never guesses a removed color/style", () => {
  const approval = { vendorStyleId: "123", vendorStyle: "5000", vendorColor: "Black" };
  assert.equal(priceQueueItem({ ...item, brand: "Other", styleNumber: "old" }, response, now, approval).resolved, true);
  assert.throws(() => priceQueueItem(item, { ...response, matchType: "closest" }, now, approval));
  assert.throws(() => priceQueueItem(item, response, now, { ...approval, vendorStyle: "different" }));
  assert.throws(() => priceQueueItem(item, response, now, { ...approval, vendorColor: "Black Heather" }));
  assert.throws(() => priceQueueItem(item, { ...response, vendor: "sanmar" }, now, approval));
});

test("mocked lookup keeps size-specific purchase prices and cart vendor context", () => {
  const priced = priceQueueItem(item, response, now);
  assert.deepEqual(priced.sizes.map(s => s.unitCost), [3, 5]);
  assert.equal(purchaseTotal(priced).total, 16);
  assert.equal(priced.vendor, "ss");
  assert.equal(priced.vendorStyleId, "123");
  assert.equal(priced.vendorCatalogColor, "Black");
  assert.equal(priced.sizes[1].vendorSize, "2XL");
  assert.equal(priced.sizes[1].sku, "sku-2XL");
  assert.equal(item.resolved, false); // No cart mutation, save, or auto-order.
  assert.deepEqual(usePoCart.getState().items, []);
});

test("zero is a valid cost, missing/invalid offers stay incomplete, never zero fallback", () => {
  const result = { ...response, colors: [{ ...response.colors[0], sizes: [size("S", 0)] }] };
  const priced = priceQueueItem(item, result, now);
  assert.deepEqual(priced.sizes.map(s => s.unitCost), [0, null]);
  assert.deepEqual(purchaseTotal(priced), { total: 0, incomplete: true, pricedSizes: 1 });
  assert.equal(purchaseCost(size("S", NaN), now), null);
  assert.equal(purchaseCost(size("S", -1), now), null);
  assert.equal(purchaseTotal(item).pricedSizes, 0);
});

test("selected totals consolidate only selected lines across invoices by vendor", () => {
  const first = priceQueueItem(item, response, now);
  const second = { ...first, key: "line2", printavoOrderId: "invoice2" };
  const missing = { ...item, key: "line3", vendor: "sanmar" as const };
  const totals = selectedPurchaseTotals([first, second, missing], new Set(["line1", "line2", "line3"]));
  assert.deepEqual(totals.get("ss"), { total: 32, incomplete: false, pricedSizes: 4 });
  assert.deepEqual(totals.get("sanmar"), { total: 0, incomplete: true, pricedSizes: 0 });
  assert.equal(selectedPurchaseTotals([first, second], new Set(["line1"])).get("ss")?.total, 16);
});

test("vendor/style/color/quantity/size changes invalidate quote context and stale responses", () => {
  const changes: Partial<CartItem>[] = [
    { vendor: "sanmar" }, { styleNumber: "5001" }, { color: "White" },
    { sizes: item.sizes.map(s => ({ ...s, qty: 3 })) },
    { sizes: item.sizes.map(s => ({ ...s, size: "M" })) },
    { brand: "Bayside" }, { description: "Other" },
  ];
  for (const change of changes) {
    const changed = { ...item, ...change };
    assert.notEqual(pricingContext(changed), pricingContext(item));
    assert.equal(isCurrentPricingRequest(item, [changed], 1, 1), false);
  }
  assert.equal(isCurrentPricingRequest(item, [item], 1, 2), false); // A → B → A/newer refresh.
  assert.equal(isCurrentPricingRequest(item, [], 1, 1), false);
  assert.equal(isCurrentPricingRequest(item, [item], 2, 2), true);
  assert.notEqual(lookupContext(item), lookupContext({ ...item, vendor: "sanmar" }));
});

test("cached results expire and sales revalidate on use", () => {
  assert.equal(freshLookup(response, now + 14 * 60000), true);
  assert.equal(freshLookup(response, now + 15 * 60000), false);
  assert.equal(freshLookup({ ...response, fetchedAt: "invalid" }, now), false);
  const sale = { ...size("S", 5), salePrice: 3, saleEndsAt: "2026-07-10" };
  assert.equal(purchaseCost(sale, now), 3);
  assert.equal(purchaseCost(sale, Date.parse("2026-07-11T00:00:00Z")), 5);
  assert.equal(purchaseCost({ ...sale, saleEndsAt: "2026-02-30" }, now), 5);
});

test("closest styles, ambiguous colors, wrong vendors, and brand mismatches fail closed", () => {
  for (const result of [
    { ...response, matchType: "closest" as const },
    { ...response, vendor: "sanmar" as const },
    { ...response, brand: "Bayside" },
    { ...response, colors: [] },
  ]) assert.throws(() => priceQueueItem(item, result, now));
});

test("only identical saved vendor PO associations preload, conflicts/guesses do not", () => {
  const line = { ...item, source: "vendor", vendorCatalogColor: "Black" };
  const po = { vendorName: "ss", lineItems: [line] } as unknown as PoFile;
  assert.equal(savedSourceVendor(item, []), null);
  assert.equal(savedSourceVendor(item, [po]), "ss");
  assert.equal(savedSourceVendor({ ...item, styleNumber: "Other" }, [po]), null);
  assert.equal(savedSourceVendor({ ...item, printavoOrderId: "other" }, [po]), null);
  assert.equal(savedSourceVendor(item, [po, { ...po, vendorName: "sanmar" }]), null);
  assert.equal(savedSourceVendor(item, [{ ...po, lineItems: [{ ...po.lineItems[0], source: "manual" }] }]), null);
});

test("initial reliable/explicit sources auto-price once; suggestions and failed contexts do not loop", () => {
  assert.equal(shouldAutoPrice(item, undefined), true);
  assert.equal(shouldAutoPrice({ ...item, vendor: "sanmar" }, undefined), true);
  assert.equal(shouldAutoPrice({ ...item, vendor: null }, undefined), false);
  assert.equal(shouldAutoPrice({ ...item, vendor: "manual" }, undefined), false);
  assert.equal(shouldAutoPrice({ ...item, styleNumber: "" }, undefined), false);
  // attempted is recorded before lookup, including an error outcome.
  assert.equal(shouldAutoPrice(item, pricingContext(item)), false);
  assert.equal(shouldAutoPrice({ ...item, vendor: "sanmar" }, pricingContext(item)), true);
});

test("automatic and manual lookups share in-flight products with maximum concurrency two", async () => {
  let active = 0;
  let peak = 0;
  const calls: string[] = [];
  const releases = new Map<string, () => void>();
  const dispatch = createQueueLookup(async request => {
    calls.push(request.style);
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.set(request.style, resolve));
    active--;
    return { ...response, styleQueried: request.style, fetchedAt: new Date().toISOString() };
  });
  const first = dispatch(item, false, () => true);
  const shared = dispatch({ ...item, key: "other-invoice-line", color: "White" }, true, () => true);
  assert.equal(first, shared);
  const secondItem = { ...item, styleNumber: "6000" };
  const thirdItem = { ...item, styleNumber: "7000" };
  const second = dispatch(secondItem, false, () => true);
  const third = dispatch(thirdItem, false, () => true);
  assert.deepEqual(calls, ["5000", "6000"]);
  releases.get("5000")!();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["5000", "6000", "7000"]);
  releases.get("6000")!();
  releases.get("7000")!();
  await Promise.all([shared, second, third]);
  assert.equal(peak, 2);
  await dispatch(item, false, () => true);
  assert.equal(calls.length, 3); // recent result reused
  const refreshed = dispatch(item, true, () => true);
  assert.equal(calls.length, 4);
  releases.get("5000")!();
  await refreshed;
});

test("obsolete queued requests skip network and shared requests retain current consumers", async () => {
  const releases: (() => void)[] = [];
  const calls: string[] = [];
  const dispatch = createQueueLookup(async request => {
    calls.push(request.style);
    await new Promise<void>(resolve => releases.push(resolve));
    return { ...response, fetchedAt: new Date().toISOString() };
  });
  const first = dispatch(item, false, () => true);
  const second = dispatch({ ...item, styleNumber: "6000" }, false, () => true);
  const obsolete = dispatch({ ...item, styleNumber: "7000" }, false, () => false);
  const rejected = assert.rejects(obsolete, /inputs changed/);
  const sharedItem = { ...item, styleNumber: "8000" };
  const oldConsumer = dispatch(sharedItem, false, () => false);
  const currentConsumer = dispatch(sharedItem, false, () => true);
  releases[0]();
  releases[1]();
  await Promise.all([first, second, rejected]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["5000", "6000", "8000"]);
  releases[2]();
  await Promise.all([oldConsumer, currentConsumer]);
});

test("lookup failure clears in-flight entry so explicit retry succeeds without automatic retry", async () => {
  let calls = 0;
  const dispatch = createQueueLookup(async () => {
    if (++calls === 1) throw new Error("Mock vendor unavailable");
    return { ...response, fetchedAt: new Date().toISOString() };
  });
  await assert.rejects(dispatch(item, false, () => true), /Mock vendor unavailable/);
  assert.equal(shouldAutoPrice(item, pricingContext(item)), false);
  await dispatch(item, true, () => true);
  assert.equal(calls, 2);
});