import assert from "node:assert/strict";
import {
  buildOpenPoMembership,
  isOpenPurchaseOrder,
  stableLineIdentity,
} from "../src/pages/vendorOrdersPoMembership.ts";

const line = (orderId, lineItemId) => ({
  printavoOrderId: orderId,
  printavoLineItemId: lineItemId,
});
const po = (overrides = {}) => ({
  id: "po-id",
  poNumber: "1042",
  lineItems: [line("invoice-a", "line-1")],
  ...overrides,
});

assert.equal(isOpenPurchaseOrder(po({ status: "submitted" })), true);
assert.equal(isOpenPurchaseOrder(po({ lifecycle: "closed" })), false);
assert.equal(isOpenPurchaseOrder(po({ lifecycle: "deleted" })), false);
assert.equal(isOpenPurchaseOrder(po({ deletedAt: "2026-01-01T00:00:00Z" })), false);

const membership = buildOpenPoMembership([
  po(),
  po({ id: "po-2", poNumber: "1043", status: "submitted" }),
  po({ id: "po-3", poNumber: "old", lifecycle: "closed" }),
  po({ id: "po-4", poNumber: "wrong-invoice", lineItems: [line("invoice-b", "line-1")] }),
  po({ id: "po-5", poNumber: "unstable", lineItems: [{ printavoOrderId: "invoice-a", printavoLineItemId: null }] }),
]);
assert.deepEqual(membership.get(stableLineIdentity("invoice-a", "line-1")), ["1042", "1043"]);
assert.deepEqual(membership.get(stableLineIdentity("invoice-b", "line-1")), ["wrong-invoice"]);
assert.equal(membership.has(stableLineIdentity("invoice-a", "missing")), false);
console.log("Vendor Orders PO membership tests passed");