import assert from "node:assert/strict";
import { previousYearRange, previousYearFilters, comparisonChange, joinComparisonRows } from "./src/lib/report-comparison.ts";
import { reportDateRange } from "./src/lib/report-date-presets.ts";

assert.deepEqual(previousYearRange("2026-10-01", "2026-10-13"), { start: "2025-10-01", end: "2025-10-13" });
assert.deepEqual(previousYearRange("2025-01-01", "2025-12-31"), { start: "2024-01-01", end: "2024-12-31" });
assert.deepEqual(previousYearRange("2025-02-01", "2025-02-28"), { start: "2024-02-01", end: "2024-02-29" });
assert.deepEqual(previousYearRange("2024-02-01", "2024-02-29"), { start: "2023-02-01", end: "2023-02-28" });
assert.deepEqual(previousYearRange("2024-02-29", "2024-03-01"), { start: "2023-02-28", end: "2023-03-01" });
assert.deepEqual(previousYearRange("2026-12-20", "2027-01-05"), { start: "2025-12-20", end: "2026-01-05" });
for (const [start, end] of [["", ""], ["2025-02-29", "2025-03-01"], ["2026-03-01", "2026-02-01"]]) {
  assert.throws(() => previousYearRange(start, end));
}
const east = reportDateRange("mtd", new Date("2026-03-01T02:00:00Z"));
assert.deepEqual(east, { start: "2026-02-01", end: "2026-02-28" });
assert.deepEqual(previousYearRange(east.start, east.end), { start: "2025-02-01", end: "2025-02-28" });
const filters = { search: "Acme", orderType: "invoice", statuses: "1||2", brands: "A", categories: "B", colors: "Blue", styleNumbers: "X", exclude: "merch", minQty: 6, maxQty: 100, minTotal: 50, maxTotal: 5000, invoiceStart: "2026-01-01", invoiceEnd: "2026-10-13", limit: 100, offset: 200 };
for (const basis of ["created", "invoice", "productionDue", "due"]) {
  const result = previousYearFilters(filters, basis, { start: "2025-01-01", end: "2025-10-13" });
  for (const key of ["search", "orderType", "statuses", "brands", "categories", "colors", "styleNumbers", "exclude", "minQty", "maxQty", "minTotal", "maxTotal"]) assert.equal(result[key], filters[key]);
  assert.equal(result[`${basis}Start`], "2025-01-01");
  assert.equal(result[`${basis}End`], "2025-10-13");
  assert.equal(result.offset, undefined);
}
assert.equal(filters.invoiceStart, "2026-01-01");
assert.deepEqual(comparisonChange(150, 100), { difference: 50, percent: 50 });
assert.deepEqual(comparisonChange(0, 100), { difference: -100, percent: -100 });
assert.deepEqual(comparisonChange(100, 0), { difference: 100, percent: null });
assert.deepEqual(comparisonChange(0, 0), { difference: 0, percent: null });
const row = (label, orders) => ({ label, orders, revenue: orders * 20, quantity: orders * 3 });
const joined = joinComparisonRows([row("new", 2), row("both", 3)], [row("old", 4), row("both", 1)]);
assert.deepEqual(joined.map(r => r.label), ["new", "both", "old"]);
assert.equal(joined[0].presence, "new");
assert.equal(joined[2].presence, "previous-only");
assert.equal(joined[2].current.orders, 0);
assert.equal(joined[1].previous.orders, 1);
console.log("PASS report comparisons: dates, leap years, Eastern boundaries, filters, baselines and row union");
