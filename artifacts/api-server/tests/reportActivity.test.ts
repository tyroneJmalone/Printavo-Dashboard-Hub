import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateActivity,
  activityCategory,
  currentOwnerMatches,
  isQualifyingActivityEvent,
  paginateReportRows,
  serializeReportOrder,
  type ReportActivityEvent,
} from "../src/lib/reports/activity.ts";

const event = (
  partial: Partial<ReportActivityEvent> & Pick<ReportActivityEvent, "entityType">,
): ReportActivityEvent => ({
  entityId: "order-1",
  orderId: null,
  eventType: "field_change",
  occurredAt: "2026-01-15T12:00:00Z",
  ...partial,
});

test("activity date boundaries use inclusive shop-local calendar dates", () => {
  const events = [
    // 00:30 ET on Jan 15
    event({ entityType: "order", occurredAt: "2026-01-15T05:30:00Z" }),
    // 23:59:59 ET on Jan 15
    event({ entityType: "order", occurredAt: "2026-01-16T04:59:59Z" }),
    // Midnight ET on Jan 16, outside the selected Jan 15 date
    event({ entityType: "order", occurredAt: "2026-01-16T05:00:00Z" }),
  ];
  const rows = aggregateActivity(events, "2026-01-15", "2026-01-15");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.changes, 2);
});

test("legacy order events and line-item events resolve to one order", () => {
  const events = [
    event({ entityType: "order", entityId: "order-1", eventType: "status_change" }),
    event({
      entityType: "line_item",
      entityId: "line-1",
      orderId: "order-1",
      eventType: "field_change",
    }),
    event({
      entityType: "line_item",
      entityId: "line-2",
      orderId: "order-1",
      eventType: "created",
    }),
  ];
  const rows = aggregateActivity(events);
  assert.deepEqual(rows.map((row) => [row.orderId, row.changes]), [["order-1", 3]]);
});

test("activity categories are mutually exclusive and reconcile to change totals", () => {
  const events = [
    event({ entityType: "line_item", orderId: "order-1", field: "quantity" }),
    event({ entityType: "line_item", orderId: "order-1", field: "unitPrice" }),
    event({ entityType: "line_item", orderId: "order-1", field: "productStatus", eventType: "field_change" }),
    event({ entityType: "line_item", orderId: "order-1", field: "color" }),
    event({ entityType: "line_item", orderId: "order-1", eventType: "created" }),
    event({ entityType: "order", field: "total" }),
    event({ entityType: "order", field: "nickname" }),
  ];
  assert.deepEqual(
    events.map((item) => activityCategory(item)),
    ["quantity", "price", "status", "lineItem", "lineItem", "price", "order"],
  );
  const [row] = aggregateActivity(events);
  assert.ok(row);
  assert.equal(Object.values(row.breakdown).reduce((sum, count) => sum + count, 0), row.changes);
  assert.deepEqual(row.breakdown, {
    quantity: 1,
    lineItem: 2,
    price: 2,
    status: 1,
    order: 1,
  });
});

test("baseline snapshots are not activity and unrelated event types are excluded", () => {
  const baselineLike = event({
    entityType: "line_item",
    entityId: "line-1",
    orderId: "order-1",
    eventType: "created",
  });
  // A line-item created event is a real observed addition, unlike a snapshot.
  assert.equal(isQualifyingActivityEvent(baselineLike), true);
  assert.equal(
    isQualifyingActivityEvent(
      event({ entityType: "order", eventType: "created" }),
    ),
    false,
  );
  assert.equal(
    isQualifyingActivityEvent(
      event({
        entityType: "line_item",
        entityId: "line-1",
        orderId: null,
        eventType: "field_change",
      }),
    ),
    false,
  );
});

test("owner filtering is against the current owner, case-insensitively", () => {
  assert.equal(currentOwnerMatches("Owner@Example.com", "owner@example.com"), true);
  assert.equal(currentOwnerMatches("historical@example.com", "current@example.com"), false);
  assert.equal(currentOwnerMatches(null, "owner@example.com"), false);
});

test("pagination slices the already-filtered unique order list", () => {
  const rows = ["order-1", "order-2", "order-3", "order-4", "order-5"];
  assert.deepEqual(paginateReportRows(rows, 2, 2), ["order-3", "order-4"]);
  assert.deepEqual(paginateReportRows(rows, 100, 2), []);
});

test("serialized activity list rows preserve matching order data", () => {
  const row = serializeReportOrder({
    id: "order-1",
    visualId: 123,
    orderType: "invoice",
    ownerEmail: "owner@example.com",
    statusName: "Production",
    nickname: "List regression",
    customerName: "Customer",
    total: 125,
    qty: 4,
    createdAt: "2026-01-15T12:00:00.000Z",
    invoiceAt: null,
    productionDueAt: null,
    dueAt: null,
    activityCount: 3,
    latestActivityAt: "2026-01-15T13:00:00.000Z",
    activityBreakdown: {
      quantity: 1,
      lineItem: 1,
      price: 1,
      status: 0,
      order: 0,
    },
    groups: [],
  });
  assert.equal(row.id, "order-1");
  assert.equal(row.activityCount, 3);
  assert.equal(row.activityBreakdown.price, 1);
  assert.equal(row.ownerEmail, "owner@example.com");
});
