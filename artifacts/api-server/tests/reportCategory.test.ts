import { test } from "node:test";
import assert from "node:assert/strict";
import { lineItemBreakdown } from "../src/lib/reports/breakdowns";
import type { ReportOrder } from "../src/lib/reports/dataset";

test("category totals use line revenue, unique orders, and an uncategorized bucket", () => {
  const orders = [{
    id: "a", total: 999,
    groups: [{ lineItems: [
      { categoryName: "Print", price: 5, items: 2 },
      { categoryName: "Print", price: 10, items: 1 },
      { categoryName: null, price: 4, items: 5 },
    ] }],
  }, {
    id: "b", total: 999,
    groups: [{ lineItems: [{ categoryName: "Print", price: 2, items: 10 }] }],
  }] as ReportOrder[];
  const rows = lineItemBreakdown(orders, li => li.categoryName, "Uncategorized");
  assert.equal(rows[0].label, "Print");
  assert.equal(rows[0].orders, 2);
  assert.equal(rows[0].quantity, 13);
  assert.equal(rows[0].revenue, 40);
  assert.equal(rows[1].label, "Uncategorized");
  assert.equal(rows[1].revenue, 20);
  assert.deepEqual(lineItemBreakdown([], li => li.categoryName, "Uncategorized"), []);
});