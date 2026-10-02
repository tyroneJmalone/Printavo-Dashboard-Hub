import assert from "node:assert/strict";
import { filterStores, matchesStore, isFilterActive, dateOnly, EMPTY_STORE_FILTERS } from "./chipply-store-filters";

const s = (storeName: string, closedAt: string | null, company: string | null = null, eventId: string | null = null) => ({
  storeName, closedAt, pvCustomerCompany: company, eventId,
});
const rows = [
  s("Fuel Summer", "2026-07-06", "Fuel Soccer Club", "12345"),
  s("Lakeside Band", "2026-06-30", "Lakeside HS"),
  s("Undated Store", null, "Fuel Soccer Club"),
  s("Edge Day", "2026-07-01T00:00:00Z"),
];
const f = (o: Partial<typeof EMPTY_STORE_FILTERS>) => ({ ...EMPTY_STORE_FILTERS, ...o });

assert.equal(filterStores(rows, EMPTY_STORE_FILTERS, (r) => r).length, 4);
assert.equal(isFilterActive(EMPTY_STORE_FILTERS), false);
assert.deepEqual(filterStores(rows, f({ query: "fuel soccer" }), (r) => r).map((r) => r.storeName), ["Fuel Summer", "Undated Store"]);
assert.equal(filterStores(rows, f({ query: "12345" }), (r) => r).length, 1);
assert.equal(filterStores(rows, f({ query: "LAKESIDE band" }), (r) => r).length, 1);
// inclusive bounds, undated excluded
assert.deepEqual(filterStores(rows, f({ closedFrom: "2026-06-30", closedTo: "2026-07-01" }), (r) => r).map((r) => r.storeName), ["Lakeside Band", "Edge Day"]);
assert.equal(matchesStore(rows[0], f({ closedFrom: "2026-07-06" })), true);
assert.equal(matchesStore(rows[0], f({ closedTo: "2026-07-06" })), true);
assert.equal(matchesStore(rows[0], f({ closedTo: "2026-07-05" })), false);
assert.equal(matchesStore(rows[2], f({ closedFrom: "2026-01-01" })), false);
assert.equal(matchesStore(rows[2], f({ query: "undated" })), true);
// reversed range is tolerated
assert.equal(filterStores(rows, f({ closedFrom: "2026-07-01", closedTo: "2026-06-30" }), (r) => r).length, 2);
assert.equal(dateOnly("garbage"), null);
assert.equal(filterStores(rows, f({ query: "nomatch" }), (r) => r).length, 0);
console.log("chipply-store-filters: all tests passed");
