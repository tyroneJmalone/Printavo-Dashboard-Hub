import { Router, type IRouter } from "express";
import { probeQuery, type StatusesPage } from "@workspace/printavo";
import {
  changeEventsTable,
  db,
  pvLineItemsTable,
  pvOrderLineItemSnapshotsTable,
  pvOrdersTable,
} from "@workspace/db";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { getPrintavoClient, printavoConfigured } from "../lib/printavoGateway";
import { lineItemLabel } from "../lib/sync/lineItemHistory";

const router: IRouter = Router();

router.get("/printavo/probe", async (req, res) => {
  if (!printavoConfigured()) {
    res.json({
      ok: false,
      message:
        "Printavo credentials are not configured (PRINTAVO_API_EMAIL / PRINTAVO_API_TOKEN)",
    });
    return;
  }
  try {
    const client = getPrintavoClient();
    const data = await client.query<StatusesPage>(probeQuery());
    const first = data.statuses.nodes[0];
    res.json({
      ok: true,
      message: first
        ? `Connected to Printavo — first status visible: "${first.name}"`
        : "Connected to Printavo — no statuses returned",
    });
  } catch (err) {
    req.log.error({ err }, "Printavo probe failed");
    res.json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Complete-observation line-item history for the order detail panel.
 *
 * This is intentionally local-only: it reads the mirror and observation
 * events, never makes a live Printavo request and never writes upstream.
 */
router.get("/printavo/orders/:orderId/history", async (req, res) => {
  const orderId = req.params.orderId;
  const requestedLimit = Number(req.query.limit ?? 25);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 25;
  const beforeSnapshotId = Number(req.query.beforeSnapshotId);
  const beforeEventId = Number(req.query.beforeEventId);
  const snapshotBefore =
    Number.isInteger(beforeSnapshotId) && beforeSnapshotId > 0
      ? beforeSnapshotId
      : null;
  const eventBefore =
    Number.isInteger(beforeEventId) && beforeEventId > 0 ? beforeEventId : null;
  try {
    const [order] = await db
      .select({
        printavoId: pvOrdersTable.printavoId,
        visualId: pvOrdersTable.visualId,
        detailSyncedAt: pvOrdersTable.detailSyncedAt,
        detailSyncState: pvOrdersTable.detailSyncState,
        detailSyncError: pvOrdersTable.detailSyncError,
      })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.printavoId, orderId))
      .limit(1);
    if (!order) {
      res.status(404).json({ error: "Printavo order was not found in the local mirror" });
      return;
    }

    const [currentItems, snapshotRows, [baseline]] = await Promise.all([
      db
        .select({
          lineItemId: pvLineItemsTable.printavoId,
          itemNumber: pvLineItemsTable.itemNumber,
          description: pvLineItemsTable.description,
          color: pvLineItemsTable.color,
          productId: pvLineItemsTable.productId,
          brand: pvLineItemsTable.brand,
          items: pvLineItemsTable.items,
          price: pvLineItemsTable.price,
          sizes: pvLineItemsTable.sizes,
          productStatus: pvLineItemsTable.productStatus,
          groupId: pvLineItemsTable.groupId,
        })
        .from(pvLineItemsTable)
        .where(eq(pvLineItemsTable.orderId, orderId)),
      db
        .select()
        .from(pvOrderLineItemSnapshotsTable)
        .where(
          snapshotBefore
            ? and(
                eq(pvOrderLineItemSnapshotsTable.orderId, orderId),
                lt(pvOrderLineItemSnapshotsTable.id, snapshotBefore),
              )
            : eq(pvOrderLineItemSnapshotsTable.orderId, orderId),
        )
        .orderBy(desc(pvOrderLineItemSnapshotsTable.id))
        .limit(limit + 1),
      db
        .select({ observedAt: pvOrderLineItemSnapshotsTable.observedAt })
        .from(pvOrderLineItemSnapshotsTable)
        .where(eq(pvOrderLineItemSnapshotsTable.orderId, orderId))
        .orderBy(asc(pvOrderLineItemSnapshotsTable.id))
        .limit(1),
    ]);
    const snapshotsHasMore = snapshotRows.length > limit;
    const snapshots = snapshotRows.slice(0, limit);

    const labels = new Map<string, string>();
    for (const snapshot of snapshots) {
      const states = Array.isArray(snapshot.lineItems)
        ? (snapshot.lineItems as Array<Record<string, unknown>>)
        : [];
      for (const state of states) {
        const lineItemId = typeof state.lineItemId === "string" ? state.lineItemId : null;
        if (!lineItemId) continue;
        if (!labels.has(lineItemId)) {
          labels.set(lineItemId, lineItemLabel(state as never));
        }
      }
    }

    const legacyLineItemEvents = sql`
      (
        ${changeEventsTable.entityType} = 'line_item'
        AND ${changeEventsTable.entityId} IN (
          SELECT DISTINCT item->>'lineItemId'
          FROM pv_order_line_item_snapshots snapshot
          CROSS JOIN LATERAL jsonb_array_elements(snapshot.line_items) AS item
          WHERE snapshot.order_id = ${orderId}
        )
      )
    `;
    const eventFilters = [
      and(
        eq(changeEventsTable.entityType, "order"),
        eq(changeEventsTable.entityId, orderId),
      ),
      and(
        eq(changeEventsTable.entityType, "line_item"),
        eq(changeEventsTable.orderId, orderId),
      ),
      legacyLineItemEvents,
    ];
    const eventWhere = eventBefore
      ? and(or(...eventFilters), lt(changeEventsTable.id, eventBefore))
      : or(...eventFilters);
    const events = await db
      .select()
      .from(changeEventsTable)
      .where(eventWhere)
      .orderBy(desc(changeEventsTable.id))
      .limit(limit + 1);
    const eventsHasMore = events.length > limit;
    const eventRows = events.slice(0, limit);
    for (const event of eventRows) {
      if (
        event.entityType === "line_item" &&
        !labels.has(event.entityId)
      ) {
        const value =
          event.eventType === "deleted" ? event.oldValue : event.newValue;
        labels.set(event.entityId, lineItemLabel(value as never));
      }
    }

    const toIso = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    };
    res.json({
      order: {
        id: order.printavoId,
        visualId: order.visualId,
        detailSyncedAt: toIso(order.detailSyncedAt),
        detailSyncState: order.detailSyncState,
        detailSyncError: order.detailSyncError,
      },
      baselineObservedAt: toIso(baseline?.observedAt),
      observations: snapshots
        .map((snapshot) => ({
          id: snapshot.id,
          observedAt: toIso(snapshot.observedAt),
          itemCount: Array.isArray(snapshot.lineItems)
            ? snapshot.lineItems.length
            : 0,
          contentHash: snapshot.contentHash,
          syncRunId: snapshot.syncRunId,
        }))
        .reverse(),
      currentItems,
      lineItemLabels: Object.fromEntries(labels),
      events: eventRows.map((event) => ({
        id: event.id,
        entityType: event.entityType,
        entityId: event.entityId,
        visualId: event.visualId,
        eventType: event.eventType,
        field: event.field,
        oldValue: event.oldValue,
        newValue: event.newValue,
        occurredAt: toIso(event.occurredAt),
        syncRunId: event.syncRunId,
      })),
      pagination: {
        snapshots: {
          hasMore: snapshotsHasMore,
          nextBeforeId: snapshotsHasMore
            ? snapshots[snapshots.length - 1]?.id ?? null
            : null,
        },
        events: {
          hasMore: eventsHasMore,
          nextBeforeId: eventsHasMore
            ? eventRows[eventRows.length - 1]?.id ?? null
            : null,
        },
      },
    });
  } catch (err) {
    req.log.error({ err, orderId }, "Printavo line-item history failed");
    res.status(500).json({ error: "Failed to load line-item history" });
  }
});

export default router;
