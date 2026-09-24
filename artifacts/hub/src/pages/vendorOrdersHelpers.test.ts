import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCartItem,
  formatPrintavoCalendarDate,
  getOrderUrgency,
  printavoDateKey,
  sortOrdersByUrgency,
  weekdayDistance,
} from "./vendorOrdersHelpers.ts";

const fridayNoonEastern = new Date("2026-07-10T16:00:00.000Z");

test("each nickname urgency term matches alone, case-insensitively and as a whole word", () => {
  assert.equal(getOrderUrgency({ nickname: "Please RuSh this", productionDueAt: null }, fridayNoonEastern).urgent, true);
  assert.equal(getOrderUrgency({ nickname: "this date is FiRm", productionDueAt: null }, fridayNoonEastern).urgent, true);
  assert.equal(getOrderUrgency({ nickname: "customer DEADLINE", productionDueAt: null }, fridayNoonEastern).urgent, true);
  assert.equal(getOrderUrgency({ nickname: "needed ASAP!", productionDueAt: null }, fridayNoonEastern).urgent, true);
  assert.equal(getOrderUrgency({ nickname: "brushed shirts", productionDueAt: null }, fridayNoonEastern).urgent, false);
  assert.equal(getOrderUrgency({ nickname: "confirmed timing", productionDueAt: null }, fridayNoonEastern).urgent, false);
  assert.equal(getOrderUrgency({ nickname: "deadlineish", productionDueAt: null }, fridayNoonEastern).urgent, false);
});

test("seven business-day boundary skips weekends", () => {
  assert.equal(weekdayDistance("2026-07-10", "2026-07-20"), 6);
  assert.equal(weekdayDistance("2026-07-10", "2026-07-21"), 7);
  assert.equal(weekdayDistance("2026-07-10", "2026-07-22"), 8);
  assert.equal(getOrderUrgency({ nickname: null, productionDueAt: "2026-07-21T00:00:00.000Z" }, fridayNoonEastern).urgent, true);
  assert.equal(getOrderUrgency({ nickname: null, productionDueAt: "2026-07-22T00:00:00.000Z" }, fridayNoonEastern).urgent, false);
});

test("Eastern today controls overdue while Printavo date stays a UTC calendar date", () => {
  const lateUtcButStillEasternFriday = new Date("2026-07-11T02:00:00.000Z");
  const urgency = getOrderUrgency(
    { nickname: null, productionDueAt: "2026-07-10T00:00:00.000Z" },
    lateUtcButStillEasternFriday,
  );
  assert.equal(urgency.overdue, false);
  assert.equal(urgency.reasons[0]?.label, "Production due today");
  assert.equal(formatPrintavoCalendarDate("2026-07-10T00:00:00.000Z"), "Jul 10, 2026");
});

test("invalid and null due dates do not create urgency", () => {
  assert.equal(printavoDateKey("2026-02-30T00:00:00Z"), null);
  assert.equal(printavoDateKey("not-a-date"), null);
  assert.equal(getOrderUrgency({ nickname: null, productionDueAt: null }, fridayNoonEastern).urgent, false);
  assert.equal(getOrderUrgency({ nickname: null, productionDueAt: "2026-02-30" }, fridayNoonEastern).urgent, false);
});

test("urgent sorting puts overdue and nearest dates first and preserves stable ties", () => {
  const orders = [
    { id: "normal-a", nickname: null, productionDueAt: "2026-08-01" },
    { id: "keyword", nickname: "rush", productionDueAt: null },
    { id: "soon-b", nickname: null, productionDueAt: "2026-07-14" },
    { id: "overdue", nickname: null, productionDueAt: "2026-07-09" },
    { id: "soon-a", nickname: null, productionDueAt: "2026-07-14" },
    { id: "normal-b", nickname: null, productionDueAt: null },
  ];
  assert.deepEqual(
    sortOrdersByUrgency(orders, fridayNoonEastern).map((order) => order.id),
    ["overdue", "soon-b", "soon-a", "keyword", "normal-a", "normal-b"],
  );
});

test("cart mapping carries invoice nickname, due date, description, and brand", () => {
  const item = buildCartItem(
    {
      orderId: "order-1",
      visualId: 1234,
      orderType: "invoice",
      nickname: "Firm Deadline",
      customerCompany: null,
      contactName: null,
      statusName: null,
      invoiceAt: null,
      productionDueAt: "2026-07-21T00:00:00.000Z",
      customerDueAt: null,
      detailSyncedAt: null,
      lineItems: [],
    },
    {
      id: "line-1",
      itemNumber: "C112",
      color: "Black",
      description: "Embroidered staff cap",
      brand: "Port Authority",
      categoryName: null,
      items: 3,
      price: null,
      sizes: [{ size: "OSFA", count: 3 }],
    },
  );
  assert.equal(item.invoiceNickname, "Firm Deadline");
  assert.equal(item.productionDueAt, "2026-07-21T00:00:00.000Z");
  assert.equal(item.description, "Embroidered staff cap");
  assert.equal(item.brand, "Port Authority");
  assert.equal(item.vendor, "sanmar");
});