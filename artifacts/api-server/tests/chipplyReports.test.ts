import assert from "node:assert/strict";
import { test } from "node:test";
import { chipplyReportCsv, filterChipplyLines, parseChipplyReportFilters, summarizeChipplyLines, type ChipplyReportLine } from "../src/lib/reports/chipplyData";

const base: ChipplyReportLine = {
  storeId: "store", storeName: "Fuel", eventId: "553498", customer: "Fuel customer",
  closedAt: "2026-05-20", transactionDate: "2026-05-01", rowOrdinal: 1, orderNumber: "100",
  processName: "PRINT: Logo", plannedMethod: "screenprint", actualMethod: "heat-transfer",
  methodChanged: true, outcome: "matched", reason: "Verified", invoiceId: "invoice",
  status: "MERCH HEAT: Complete", nickname: "553498 Fuel HEAT: Logo",
  vendor: "Vendor", product: "Tee", style: "PC54", color: "Blue", size: "M",
  quantity: 2, itemTotalCents: 5000,
};
// Deliberately share an order across product lines: fees must never be repeated.
const lines = [base, { ...base, rowOrdinal: 2, style: "PC61", quantity: 1, itemTotalCents: 2500, actualMethod: null, methodChanged: null, outcome: "ambiguous", invoiceId: null }];
test("method and product partitions preserve original cents without repeating order revenue", () => {
  const all = summarizeChipplyLines(lines);
  assert.equal(all.orderCount, 1);
  assert.equal(all.itemTotalCents, 7500);
  assert.equal(all.quantity, 3);
  assert.equal(all.unallocatedItemTotalCents, 2500);
  assert.equal(summarizeChipplyLines(filterChipplyLines(lines, { style: "PC54" })).itemTotalCents +
    summarizeChipplyLines(filterChipplyLines(lines, { style: "PC61" })).itemTotalCents, all.itemTotalCents);
  assert.equal(summarizeChipplyLines(filterChipplyLines(lines, { actualMethod: "heat-transfer" })).itemTotalCents +
    summarizeChipplyLines(filterChipplyLines(lines, { actualMethod: "Unallocated" })).itemTotalCents, all.itemTotalCents);
  assert.ok(!("orderTotalCents" in all));
});
test("date basis is explicit and missing dates never pass a date range", () => {
  assert.equal(filterChipplyLines(lines, { dateBasis: "closed", start: "2026-05-20", end: "2026-05-20" }).length, 2);
  assert.equal(filterChipplyLines(lines, { dateBasis: "transaction", start: "2026-05-20" }).length, 0);
  assert.equal(filterChipplyLines([{ ...base, closedAt: null }], { start: "2026-01-01" }).length, 0);
});
test("all filters combine and ambiguous lines never become planned actuals", () => {
  assert.equal(filterChipplyLines(lines, { store: "553498", customer: "fuel", vendor: "vendor", product: "tee", plannedMethod: "screenprint", actualMethod: "heat-transfer", methodChanged: "yes", status: "complete", outcome: "matched" }).length, 1);
  assert.equal(filterChipplyLines(lines, { actualMethod: "screenprint" }).length, 0);
  assert.equal(filterChipplyLines(lines, { methodChanged: "unallocated" }).length, 1);
});
test("CSV uses the same filtered rows and no order-level money", () => {
  const csv = chipplyReportCsv(filterChipplyLines(lines, { style: "PC61" }));
  assert.equal(csv.split("\r\n").length, 2);
  assert.match(csv, /"2500"/);
  assert.match(csv, /"Unallocated"/);
  assert.doesNotMatch(csv, /orderTotal|shipping|tax|5000/);
  assert.match(chipplyReportCsv([{ ...base, product: "=SUM(A1)", reason: 'a "quote"' }]), /"'=SUM\(A1\)"/);
  assert.match(chipplyReportCsv([{ ...base, reason: 'a "quote"' }]), /"a ""quote"""/);
});
test("mixed is a distinct allocated bucket and order identities are scoped per store", () => {
  const rows = [base, { ...base, storeId: "other", actualMethod: "mixed" }];
  assert.equal(summarizeChipplyLines(rows).orderCount, 2);
  assert.equal(filterChipplyLines(rows, { actualMethod: "mixed" }).length, 1);
});
test("invalid query shapes and inverted dates are rejected", () => {
  assert.throws(() => parseChipplyReportFilters({ style: ["a", "b"] }));
  assert.throws(() => parseChipplyReportFilters({ dateBasis: "invoice" }));
  assert.throws(() => parseChipplyReportFilters({ start: "2026-02-30" }));
  assert.throws(() => parseChipplyReportFilters({ start: "2026-05-02", end: "2026-05-01" }));
  assert.equal(parseChipplyReportFilters({}).dateBasis, "closed");
});