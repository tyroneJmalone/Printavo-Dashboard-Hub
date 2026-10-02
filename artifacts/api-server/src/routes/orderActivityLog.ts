import { Router, type IRouter } from "express";
import { db, pvOrdersTable } from "@workspace/db";
import { eq, sql, type SQL } from "drizzle-orm";
import { getEnabledModuleKeys } from "../lib/auth/moduleAccess";
import {
  ActivityInputError, activityCategories, activityDate, boundedInteger,
  conversionIdentitySql, decodeActivityCursor, encodeActivityCursor,
  printingAllowed, safeActivityValue,
} from "../lib/orderActivityLog";

const router: IRouter = Router();
const orderColumns = sql`printavo_id AS id, visual_id AS "visualId",
  COALESCE(customer_company, contact_name, '') AS "customerName",
  nickname, status_name AS "statusName", order_type AS "orderType"`;

router.get("/order-activity-log/orders", async (req, res) => {
  try {
    const limit = boundedInteger(req.query.limit, 25, 1, 100);
    const offset = boundedInteger(req.query.offset, 0, 0, 100000);
    if (req.query.search !== undefined && (typeof req.query.search !== "string" || req.query.search.length > 200)) {
      throw new ActivityInputError("Search must be a string of at most 200 characters");
    }
    const search = (req.query.search as string | undefined)?.trim() ?? "";
    const number = search.replace(/^#/, "");
    const visualId = /^\d+$/.test(number) && Number(number) <= 2147483647 ? Number(number) : null;
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const where = search ? sql`(visual_id = ${visualId} OR customer_company ILIKE ${pattern}
      OR contact_name ILIKE ${pattern} OR nickname ILIKE ${pattern})` : sql`TRUE`;
    const [orders, count] = await Promise.all([
      db.execute(sql`SELECT ${orderColumns} FROM pv_orders WHERE ${where}
        ORDER BY first_seen_at DESC, printavo_id COLLATE "C" DESC LIMIT ${limit} OFFSET ${offset}`),
      db.execute(sql`SELECT count(*)::integer AS total FROM pv_orders WHERE ${where}`),
    ]);
    res.json({ orders: orders.rows, total: count.rows[0]?.total ?? 0 });
  } catch (err) {
    if (err instanceof ActivityInputError) { res.status(400).json({ error: err.message }); return; }
    req.log.error({ err }, "Order activity search failed");
    res.status(500).json({ error: "Failed to search the local order activity log" });
  }
});

router.get("/order-activity-log/orders/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId || orderId.length > 200) throw new ActivityInputError("Invalid order ID");
    const limit = boundedInteger(req.query.limit, 50, 1, 100);
    const category = req.query.category ?? "all";
    if (typeof category !== "string" || !activityCategories.includes(category as typeof activityCategories[number])) throw new ActivityInputError("Invalid category");
    const start = activityDate(req.query.start);
    const end = activityDate(req.query.end);
    if (start && end && start > end) throw new ActivityInputError("Start must not be after end");
    const allowPrinting = printingAllowed(req.staff?.role, req.staff?.role === "admin" ? new Set() : await getEnabledModuleKeys());
    const scope = JSON.stringify([orderId, category, start, end, allowPrinting]);
    const cursor = decodeActivityCursor(req.query.cursor, scope);
    const [order] = await db.select({
      id: pvOrdersTable.printavoId, visualId: pvOrdersTable.visualId,
      customerCompany: pvOrdersTable.customerCompany, contactName: pvOrdersTable.contactName,
      customerId: pvOrdersTable.customerId, nickname: pvOrdersTable.nickname,
      statusName: pvOrdersTable.statusName, orderType: pvOrdersTable.orderType,
      detailSyncState: pvOrdersTable.detailSyncState, detailSyncedAt: pvOrdersTable.detailSyncedAt,
    }).from(pvOrdersTable).where(eq(pvOrdersTable.printavoId, orderId)).limit(1);
    if (!order) { res.status(404).json({ error: "Order was not found in the local Printavo mirror" }); return; }

    const identities = sql`WITH RECURSIVE identities(id) AS (
      SELECT ${orderId}::text
      UNION
      SELECT c.old_value->>'printavoId' FROM identities i
      JOIN change_events c ON c.entity_id = i.id WHERE ${conversionIdentitySql(order.customerId)}
    )`;
    const filters = sql`(${category} = 'all' OR category = ${category})
      AND (${start}::timestamptz IS NULL OR time >= ${start}::timestamptz)
      AND (${end}::timestamptz IS NULL OR time <= ${end}::timestamptz)
      ${cursor ? sql`AND (time, source COLLATE "C", id COLLATE "C") <
        (${cursor.time}::timestamptz, ${cursor.source}::text COLLATE "C", ${cursor.id}::text COLLATE "C")` : sql``}`;
    // Each source is filtered and bounded in SQL before the final merge.
    const pageSource = (query: SQL) => sql`(SELECT * FROM (${query}) source_rows WHERE ${filters}
      ORDER BY time DESC, source COLLATE "C" DESC, id COLLATE "C" DESC LIMIT ${limit + 1})`;
    const changes = sql`SELECT c.id::text AS id, 'change_events'::text AS source,
      CASE WHEN c.event_type = 'status_change' OR c.field = 'productStatus' THEN 'status'
        WHEN c.entity_type = 'line_item' THEN 'line-items' ELSE 'order' END AS category,
      date_trunc('milliseconds', c.occurred_at) AS time, 'observation'::text AS kind,
      CASE WHEN c.entity_type = 'line_item' THEN 'Line item ' || c.event_type
        WHEN c.event_type = 'converted' THEN 'Quote converted to invoice'
        WHEN c.event_type = 'created' THEN 'Order first observed'
        ELSE 'Order ' || c.event_type END AS title,
      COALESCE(c.field, 'Persisted sync observation') AS description,
      c.old_value AS old_value, c.new_value AS new_value
      FROM change_events c WHERE
      ((c.entity_type = 'order' AND c.entity_id IN (SELECT id FROM identities))
        OR (c.entity_type = 'line_item' AND c.order_id IN (SELECT id FROM identities)))
      AND COALESCE(c.field, '') NOT ILIKE '%email%'`;
    const payments = sql`SELECT p.printavo_id AS id, 'pv_payments'::text AS source, 'payments'::text AS category,
      date_trunc('milliseconds', COALESCE(p.transaction_date::timestamp AT TIME ZONE 'UTC', p.first_seen_at)) AS time,
      CASE WHEN p.transaction_date IS NULL THEN 'observation' ELSE 'business-date' END AS kind,
      p.typename || ' record' AS title,
      CASE WHEN p.transaction_date IS NULL THEN 'Payment first observed; business date unavailable.'
        ELSE 'Payment business date (user-settable), not the actual change time.' END AS description,
      NULL::jsonb AS old_value, to_jsonb(p.amount) AS new_value
      FROM pv_payments p WHERE p.order_id IN (SELECT id FROM identities)`;
    const files = sql`SELECT f.id::text || ':' || m.kind AS id, 'pv_files'::text AS source, 'files'::text AS category,
      date_trunc('milliseconds', m.time) AS time, 'milestone'::text AS kind,
      CASE WHEN m.kind = 'observed' THEN 'File first observed' ELSE 'File mirrored' END AS title,
      'Local ' || f.source_kind || ' milestone; not an artwork upload timestamp.' AS description,
      NULL::jsonb AS old_value, NULL::jsonb AS new_value
      FROM pv_files f CROSS JOIN LATERAL (VALUES ('observed', f.first_seen_at), ('mirrored', f.mirrored_at)) m(kind, time)
      WHERE f.order_printavo_id IN (SELECT id FROM identities) AND m.time IS NOT NULL`;
    const printing = sql`SELECT j.id::text AS id, 'pq_print_jobs'::text AS source, 'printing'::text AS category,
      date_trunc('milliseconds', COALESCE(j.printed_at, j.created_at)) AS time, 'job-outcome'::text AS kind,
      'Auto-print: ' || j.status AS title,
      'Recorded ' || j.doc_type || ' job outcome; submission does not confirm physical printing.' AS description,
      NULL::jsonb AS old_value, to_jsonb(j.status) AS new_value
      FROM pq_print_jobs j WHERE j.printavo_order_id IN (SELECT id FROM identities) AND j.status <> 'pending'`;
    const sources = [pageSource(changes), pageSource(payments), pageSource(files)];
    if (allowPrinting) sources.push(pageSource(printing));
    const [timeline, baseline, lineage] = await Promise.all([
      db.execute(sql`${identities} SELECT * FROM (${sql.join(sources, sql` UNION ALL `)}) unified
        ORDER BY time DESC, source COLLATE "C" DESC, id COLLATE "C" DESC LIMIT ${limit + 1}`),
      db.execute(sql`${identities} SELECT observed_at FROM pv_order_line_item_snapshots
        WHERE order_id IN (SELECT id FROM identities) ORDER BY observed_at ASC, id ASC LIMIT 1`),
      db.execute(sql`${identities} SELECT
        EXISTS(SELECT 1 FROM identities WHERE id <> ${orderId}) AS linked,
        EXISTS(SELECT 1 FROM change_events c WHERE c.entity_type = 'order'
          AND c.entity_id IN (SELECT id FROM identities) AND c.event_type = 'converted'
          AND NOT COALESCE((${conversionIdentitySql(order.customerId)}), FALSE)) AS unverified`),
    ]);
    const rows = timeline.rows.slice(0, limit);
    const iso = (value: unknown) => new Date(value as string | Date).toISOString();
    const notes = [
      "Sync changes are observation times at polling granularity, not actual edit times; Printavo supplies no editor attribution.",
      "No past edits are reconstructed. History before the oldest complete detail baseline may be unavailable; current items remain available through the existing order history endpoint.",
      "Payment dates are user-settable business dates. File milestones are local first-observed/latest-mirrored times, not artwork upload times.",
      "Email activity is excluded. Only persisted local records are included; this is not a complete upstream audit log.",
    ];
    if (!baseline.rows[0]) notes.push("No complete line-item detail baseline has been recorded.");
    if (order.detailSyncState !== "complete") notes.push(`Current detail coverage is ${order.detailSyncState}; line-item history may have gaps.`);
    if (order.detailSyncedAt) notes.push(`Latest detail sync observed at ${order.detailSyncedAt.toISOString()}.`);
    if (lineage.rows[0]?.linked) notes.push("Prior quote change events are included only through recorded ID and matching-customer conversion evidence. Prior quote detail snapshots may not survive conversion; the baseline reflects retained complete snapshots only.");
    if (lineage.rows[0]?.unverified) notes.push("Some conversion evidence is incomplete or unverified; prior quote history was not linked by invoice number.");
    if (!allowPrinting) notes.push("Auto-print records are omitted because Production access is not enabled.");
    else notes.push("Auto-print records reflect job outcomes/submissions, not confirmation of physical printing.");
    const last = rows.at(-1);
    res.json({
      order: { id: order.id, visualId: order.visualId, customerName: order.customerCompany ?? order.contactName ?? "",
        nickname: order.nickname, statusName: order.statusName, orderType: order.orderType },
      events: rows.map(row => ({ id: `${row.source}:${row.id}`, source: row.source, category: row.category,
        title: safeActivityValue(row.title), description: safeActivityValue(row.description),
        occurredAt: iso(row.time), timestampKind: row.kind,
        oldValue: safeActivityValue(row.old_value), newValue: safeActivityValue(row.new_value) })),
      nextCursor: timeline.rows.length > limit && last ? encodeActivityCursor({
        v: 1, scope, time: iso(last.time), source: String(last.source), id: String(last.id),
      }) : null,
      coverage: { baselineObservedAt: baseline.rows[0] ? iso(baseline.rows[0].observed_at) : null, notes },
    });
  } catch (err) {
    if (err instanceof ActivityInputError) { res.status(400).json({ error: err.message }); return; }
    req.log.error({ err }, "Order activity timeline failed");
    res.status(500).json({ error: "Failed to load the local order activity log" });
  }
});

export default router;