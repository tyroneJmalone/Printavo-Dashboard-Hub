import test from "node:test";
import assert from "node:assert/strict";
import { selectionCounts, selectionKey, toggleSelection } from "./categorySelection.ts";

test("counts only explicit lines and distinct invoices", () => {
  assert.deepEqual(selectionCounts([]), { invoices: 0, lines: 0 });
  assert.deepEqual(selectionCounts([
    { orderId: "1", lineItemId: "a" },
    { orderId: "1", lineItemId: "b" },
    { orderId: "2", lineItemId: "c" },
  ]), { invoices: 2, lines: 3 });
});

test("selection keys do not collide across invoices or delimiters", () => {
  assert.notEqual(selectionKey({ orderId: "1", lineItemId: "2" }), selectionKey({ orderId: "2", lineItemId: "1" }));
  assert.notEqual(selectionKey({ orderId: "a:b", lineItemId: "c" }), selectionKey({ orderId: "a", lineItemId: "b:c" }));
});

test("selection is idempotent, explicitly removable, and bounded", () => {
  const a = { orderId: "1", lineItemId: "a" };
  const b = { orderId: "1", lineItemId: "b" };
  const first = toggleSelection([], a, true, 1);
  assert.deepEqual(first, [a]);
  assert.deepEqual(toggleSelection(first, a, true, 1), [a]);
  assert.deepEqual(toggleSelection(first, b, true, 1), [a]);
  assert.deepEqual(toggleSelection(first, a, false, 1), []);
});