import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { loadReportOrders, productionMerchSql } from "./dataset";
import { parseReportFilters } from "./filters";
import { addDays, monday, observedDay, workloadCompletion, pastProductionDate, indexEvents, excludedStatus, merchMatches, genericPickedUp,
  productionWorkload, type CompletionEvent, type WorkloadOptions } from "./productionWorkload";

/** Small invoice headers + change feed first; load heavy groups only for
 * relevant pending jobs or the chosen historical completion window. */
export async function loadProductionWorkload(options: WorkloadOptions) {
  const [headers, changes, statuses] = await Promise.all([
    db.execute(sql`SELECT printavo_id, status_name, ${productionMerchSql} AS merch,
      to_char(production_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS due
      FROM pv_orders WHERE order_type = 'invoice'`),
    db.execute(sql`SELECT entity_id AS order_id, occurred_at,
      CASE WHEN jsonb_typeof(old_value) = 'string' THEN old_value #>> '{}' ELSE old_value ->> 'name' END AS old_status,
      CASE WHEN jsonb_typeof(new_value) = 'string' THEN new_value #>> '{}' ELSE new_value ->> 'name' END AS new_status
      FROM change_events WHERE entity_type = 'order' AND event_type = 'status_change' AND field = 'status'
      ORDER BY occurred_at, id`),
    db.execute(sql`SELECT name FROM pv_statuses`),
  ]);
  const events: CompletionEvent[] = changes.rows.map(r => ({
    orderId: String(r.order_id), at: new Date(r.occurred_at as string).toISOString(),
    oldStatus: r.old_status as string | null, newStatus: r.new_status as string | null,
  }));
  const today = observedDay(new Date().toISOString()), baselineStart = addDays(monday(today), -7 * options.baselineWeeks);
  const baselineEnd = addDays(monday(today), -1), byOrder = indexEvents(events);
  const ids: string[] = [];
  let extraUndated = 0;
  let historyAvailableFrom: string | null = null;
  for (const h of headers.rows) {
    const due = h.due ? String(h.due) : null;
    const produced = pastProductionDate(due, today);
    if ((!produced && excludedStatus(h.status_name as string | null)) || !merchMatches(Boolean(h.merch), options.merch)) continue;
    if (produced && (!historyAvailableFrom || produced < historyAvailableFrom)) historyAvailableFrom = produced;
    const orderEvents = byOrder.get(String(h.printavo_id)) ?? [];
    const evidence = workloadCompletion(h.status_name as string | null, orderEvents, options.method, due, today);
    const historical = !!evidence.day && evidence.day >= baselineStart && evidence.day <= baselineEnd;
    // Generic pickup cannot identify a method from the header. Classify its
    // groups before counting undated completion; never count it in both by default.
    const classifyUndated = evidence.done && !evidence.day && (genericPickedUp(h.status_name as string | null)
      || orderEvents.some(e => genericPickedUp(e.oldStatus) || genericPickedUp(e.newStatus)));
    if (evidence.done && !evidence.day && !classifyUndated) extraUndated++;
    const pending = !evidence.done && (!h.due || String(h.due) <= options.end);
    if (historical || pending || classifyUndated) ids.push(String(h.printavo_id));
  }
  const orders = await loadReportOrders(parseReportFilters({ orderType: "invoice" }).filters, { includeMerch: true, orderIds: ids });
  const report = productionWorkload(orders, events, options, historyAvailableFrom, today, extraUndated);
  const { finishedStatus } = await import("./productionWorkload");
  report.recognizedCompletionStatuses = [...new Set([...report.recognizedCompletionStatuses,
    ...statuses.rows.map(s => String(s.name)).filter(s => finishedStatus(s, options.method))])].sort();
  return report;
}
