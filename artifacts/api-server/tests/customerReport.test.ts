import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomerReport, parseCustomerRanges } from "../src/lib/reports/customers";
import type { ReportOrder } from "../src/lib/reports/dataset";

const order = (id: string, customerId: string | null, total = 100, qty = 12): ReportOrder => ({
  id, customerId, customerName: "Same Display Name", total, qty, orderType: "invoice", invoiceAt: "2026-10-22",
  groups: [{ id: "g", imprints: [], lineItems: [
    { itemNumber: "A", color: null, brand: null, categoryName: "Screen Printing", items: qty, price: 1 },
    { itemNumber: "B", color: null, brand: null, categoryName: "Embroidery", items: 0, price: 1 },
  ] }],
} as ReportOrder);

test("groups stable customer identities, never equal names; duplicate order cannot inflate totals", () => {
  const a = order("1", "A"), b = order("2", "A", 50, 6), c = order("3", "B");
  b.customerName = "Old company name";
  const result = buildCustomerReport([a, a, b, c]);
  assert.equal(result.customerCount, 2);
  assert.equal(result.orders, 3);
  assert.equal(result.revenue, 250);
  assert.equal(result.quantity, 30);
  assert.equal(result.customers[0].orders, 2);
  assert.equal(result.customers[0].avgOrderValue, 75);
  assert.deepEqual(result.customers[0].categories, ["Embroidery", "Screen Printing"]);
});
test("unlinked orders stay separate and are not counted as known customers", () => {
  const result = buildCustomerReport([order("1", null), order("2", null), order("3", "A")]);
  assert.equal(result.customers.length, 3);
  assert.equal(result.customerCount, 1);
  assert.equal(result.unlinkedOrders, 2);
  assert.equal(buildCustomerReport([order("1", null), order("2", null)], { minCustomerOrders: 2 }).orders, 0);
});
test("customer ranges apply to totals after aggregation, inclusively; summary matches surviving customers", () => {
  const orders = [order("1", "A", 100, 10), order("2", "A", 100, 10), order("3", "B", 300, 30)];
  const result = buildCustomerReport(orders, { minCustomerTotal: 200, maxCustomerTotal: 200,
    minCustomerQty: 20, maxCustomerQty: 20, minCustomerOrders: 2, maxCustomerOrders: 2 });
  assert.equal(result.customers.length, 1);
  assert.equal(result.revenue, 200);
  assert.equal(result.quantity, 20);
  assert.equal(result.orders, 2);
});
test("quote count and invoice dates are explicit and empty results safe", () => {
  const a = order("1", "A"), b = order("2", "A");
  b.orderType = "quote"; b.invoiceAt = "2026-09-01";
  const row = buildCustomerReport([a, b]).customers[0];
  assert.equal(row.invoices, 1); assert.equal(row.quotes, 1);
  assert.equal(row.firstInvoiceDate, "2026-09-01");
  assert.equal(row.lastInvoiceDate, "2026-10-22");
  assert.deepEqual(buildCustomerReport([]), { customers: [], customerCount: 0, unlinkedOrders: 0, orders: 0, revenue: 0, quantity: 0 });
});
test("validates finite nonnegative numeric ranges and integer counts", () => {
  for (const value of ["NaN", "Infinity", "-1", " ", ["1"], {}]) {
    assert.ok(parseCustomerRanges({ minCustomerTotal: value }).errors.length);
  }
  assert.ok(parseCustomerRanges({ minCustomerOrders: "1.5" }).errors.length);
  assert.ok(parseCustomerRanges({ minCustomerQty: "20", maxCustomerQty: "10" }).errors.length);
  assert.equal(parseCustomerRanges({ minCustomerTotal: "0", maxCustomerOrders: "12" }).errors.length, 0);
});
