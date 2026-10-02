import assert from "node:assert/strict";
import { test } from "node:test";
import { activityChangeRows, activityFieldLabel } from "./orderActivityChanges";

test("quantity compares totals and matches reordered sizes by label", () => {
  const rows = activityChangeRows("quantity",
    JSON.stringify({ items: 5, sizes: [{ size: "S", count: 2 }, { size: "M", count: 3 }] }),
    JSON.stringify({ items: 7, sizes: [{ size: "M", count: 5 }, { size: "S", count: 2 }] }));
  assert.deepEqual(rows.find(r => r.label === "Size: M"), { label: "Size: M", before: "3", after: "5", changed: true });
  assert.equal(rows.find(r => r.label === "Size: S")?.changed, false);
  assert.equal(rows.find(r => r.label === "Total quantity")?.after, "7");
});
test("missing, zero and empty remain distinct", () => {
  assert.deepEqual(activityChangeRows("unitPrice", null, "0")[0],
    { label: "Unit price", before: "Not recorded", after: "$0.00", changed: true });
  assert.equal(activityChangeRows("unitPrice", "", "12.5")[0].before, "(empty)");
  assert.equal(activityChangeRows("unitPrice", "", "12.5")[0].after, "$12.50");
  assert.equal(activityChangeRows("description", "null", "123")[0].before, "null");
});
test("product fields and malformed legacy JSON remain readable", () => {
  const rows = activityChangeRows("product", '{"brand":"A","itemNumber":"100"}', '{"brand":"A","itemNumber":"200"}');
  assert.equal(rows.find(r => r.label === "Brand")?.changed, false);
  assert.equal(rows.find(r => r.label === "Item number")?.changed, true);
  assert.equal(activityChangeRows("description", "{truncated", "New")[0].before, "{truncated");
  assert.equal(activityFieldLabel("unitPrice"), "Unit price");
});