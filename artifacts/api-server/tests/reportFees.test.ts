import { test } from "node:test";
import assert from "node:assert/strict";
import { feeRows } from "../src/lib/reports/fees";
import type { ReportOrder } from "../src/lib/reports/dataset";

test("fee grouping counts invoices once, uses charged amounts, and excludes quotes", () => {
  const orders = [
    { id: "1", visualId: 1, orderType: "invoice" },
    { id: "2", visualId: 2, orderType: "invoice" },
    { id: "3", visualId: 3, orderType: "quote" },
  ] as ReportOrder[];
  const source = (id: string, fees: unknown[]) => ({ printavo_id: id, extras_synced_at: "2026-01-01", extras_stale: false, extras: { fees } });
  const result = feeRows(orders, [
    source("1", [{ description: "Rush", amount: 10.1, quantity: 3 }, { description: "Rush", amount: 2.2 }, { description: "Shipping", amount: 5 }, { description: "Free", amount: 0 }]),
    source("2", [{ description: "Rush", amount: -1 }, { description: "Unknown", amount: null }]),
    source("3", [{ description: "Rush", amount: 999 }]),
  ]);
  assert.equal(result.rows[0].amount, 11.3);
  assert.equal(result.rows[0].invoices.length, 2);
  assert.equal(result.rows[0].invoices[0].amount, 12.3);
  assert.equal(result.rows.length, 2);
  assert.equal(result.incomplete, 0);
  assert.equal(feeRows(orders, [{ printavo_id: "1", extras: null }]).incomplete, 1);
});