import test from "node:test";
import assert from "node:assert/strict";
import type { SanMarProductEntry } from "@workspace/sanmar";
import { sanMarToColors } from "../src/lib/purchasing/vendorLookup";
import { findReusableColorMatch } from "../../hub/src/components/purchasing/cartMatching";
import { priceQueueItem } from "../../hub/src/components/purchasing/queuePricing";
import type { CartItem } from "../../hub/src/stores/poCart";

const row = (catalogColor: string, size: string, cost: number, id: number) => ({
  style: "5400", brandName: "Gildan", catalogColor, size, casePrice: cost,
  piecePrice: null, caseSalePrice: null, pieceSalePrice: null, saleEndDate: null,
  inventoryKey: `key-${id}`, sizeIndex: id, colorSwatchImage: null, colorProductImage: null,
} as SanMarProductEntry);
const entries = [
  ...["S", "M", "L", "XL"].map((size, i) => row("Royal", size, 5.89, i)),
  row("ROYAL", "2XL", 6.99, 4), row("ROYAL", "3XL", 9.06, 5),
];

test("pure-case SanMar colors preserve both approval spellings and all size identifiers", () => {
  const colors = sanMarToColors([...entries, row("Dark Royal", "M", 11, 7), row("Royal Heather", "M", 12, 8)]);
  for (const spelling of ["Royal", "ROYAL"]) {
    const bucket = colors.find(c => c.colorName === spelling)!;
    assert.deepEqual(bucket.sizes.map(s => [s.size, s.cost, s.inventoryKey, s.sizeIndex, s.sku]), [
      ["S", 5.89, "key-0", 0, null], ["M", 5.89, "key-1", 1, null],
      ["L", 5.89, "key-2", 2, null], ["XL", 5.89, "key-3", 3, null],
      ["2XL", 6.99, "key-4", 4, null], ["3XL", 9.06, "key-5", 5, null],
    ]);
    assert.deepEqual(findReusableColorMatch(spelling, colors.map(c => c.colorName), colors),
      { kind: "exact", value: spelling });
    const item = { vendor: "sanmar", brand: "Gildan", color: spelling,
      sizes: bucket.sizes.map(s => ({ size: s.size, qty: 1 })) } as CartItem;
    const result = { vendor: "sanmar" as const, found: true, matchType: "exact" as const,
      colors, fetchedAt: new Date().toISOString(), cached: false, styleQueried: "5400",
      styleName: "5400", styleId: null, brand: "Gildan", title: null, styleImage: null };
    for (const approval of [undefined, { vendorStyle: "5400", vendorStyleId: null, vendorColor: spelling }]) {
      const priced = priceQueueItem(item, result, Date.now(), approval);
      assert.deepEqual(priced.sizes.map(s => s.unitCost), [5.89, 5.89, 5.89, 5.89, 6.99, 9.06]);
    }
  }
  assert.equal(colors.find(c => c.colorName === "Dark Royal")!.sizes.length, 1);
  assert.equal(colors.find(c => c.colorName === "Royal Heather")!.sizes.length, 1);
});

test("case aliases with contradictory same-size offers stay ambiguous, including saved approvals", () => {
  const colors = sanMarToColors([...entries, row("ROYAL", "M", 99, 99)]);
  assert.deepEqual(findReusableColorMatch("Royal", colors.map(c => c.colorName), colors),
    { kind: "ambiguous", value: null });
  for (const spelling of ["Royal", "ROYAL"]) {
    const priced = priceQueueItem({ vendor: "sanmar", color: spelling, brand: "Gildan",
      sizes: [{ size: "M", qty: 1 }] } as CartItem,
    { vendor: "sanmar", found: true, matchType: "exact", styleName: "5400", styleId: null,
      brand: "Gildan", colors, fetchedAt: new Date().toISOString(), cached: false,
      styleQueried: "5400", title: null, styleImage: null }, Date.now(),
    { vendorStyle: "5400", vendorStyleId: null, vendorColor: spelling });
    assert.equal(priced.sizes[0].unitCost, null);
    assert.equal(priced.sizes[0].inventoryKey, null);
  }
});