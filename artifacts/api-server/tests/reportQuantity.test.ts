import { test } from "node:test";
import assert from "node:assert/strict";
import { orderQuantityBreakdown } from "../src/lib/reports/breakdowns";
import type { ReportOrder } from "../src/lib/reports/dataset";

test("quantity ranges match all requested boundaries with no gaps or overlaps", () => {
  const labels = ["1-5", "6-11", "12-23", "24-35", "36-47", "48-59", "60-71", "72-83", "84-95", "96-107", "108-119", "120-143", "144-167", "168-191", "192-215", "216-239", "240-263", "264-287", "288+"];
  assert.deepEqual(orderQuantityBreakdown([]).map(r => r.label), labels);
  const orders = Array.from({ length: 301 }, (_, qty) => ({ id: String(qty), qty, total: 10 })) as ReportOrder[];
  const rows = orderQuantityBreakdown(orders);
  assert.equal(rows.reduce((sum, r) => sum + r.orders, 0), 300);
  for (const row of rows) {
    const [min, max = 300] = row.label.replace("+", "").split("-").map(Number);
    assert.equal(row.orders, max - min + 1);
    assert.equal(row.revenue, row.orders * 10);
    const expected = orders.filter(o => o.qty >= min && o.qty <= max);
    assert.equal(row.quantity, expected.reduce((sum, o) => sum + o.qty, 0));
  }
  assert.equal(orderQuantityBreakdown([{ id: "large", qty: 10000, total: 5 }] as ReportOrder[])[18].orders, 1);
});