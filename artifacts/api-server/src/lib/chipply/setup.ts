import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { getChipplyDataDetail } from "./dataService";
import { getStoreSummary } from "./summaryService";

export interface SetupProgress {
  currentStep: number; version: number; confirmedSteps: number[];
  marginSkipped: boolean; notes: string; evidenceKey: string; updatedAt: Date | string | null;
}

/** Confirmation is evidence-bound; visiting a step never verifies business data. */
export function effectiveProgress(saved: SetupProgress | undefined, evidenceKey: string) {
  const stale = !!saved && saved.evidenceKey !== evidenceKey;
  return {
    currentStep: saved?.currentStep ?? 1,
    version: saved?.version ?? 0,
    confirmedSteps: stale ? [] : saved?.confirmedSteps ?? [],
    marginSkipped: saved?.marginSkipped ?? false,
    notes: saved?.notes ?? "",
    updatedAt: saved?.updatedAt ?? null,
    staleConfirmations: stale && !!saved?.confirmedSteps.length,
  };
}

export async function getSetup(storeId: string) {
  const stores = await pool.query(`SELECT id,store_name,event_id,pv_customer_id,closed_at::text,
    (SELECT count(*)::int FROM chipply_store_styles WHERE store_id=s.id) AS margin_rows
    FROM chipply_stores s WHERE id=$1`, [storeId]);
  const store = stores.rows[0];
  if (!store) return null;
  const [detail, invoices, progress] = await Promise.all([
    getChipplyDataDetail(storeId),
    pool.query(`SELECT o.printavo_id,o.nickname,o.customer_id,o.customer_company,o.contact_name,
      o.production_due_at,o.status_name,o.detail_sync_state,o.detail_synced_at,o.printavo_updated_at,
      (SELECT count(*)::int FROM pv_line_items l WHERE l.order_id=o.printavo_id AND l.category_id IS NULL) AS missing,
      (SELECT md5(coalesce(string_agg(concat_ws('|',l.printavo_id,l.item_number,l.color,l.items,l.sizes::text,l.category_id),';' ORDER BY l.printavo_id),'')) FROM pv_line_items l WHERE l.order_id=o.printavo_id) AS line_hash
      FROM pv_orders o WHERE o.order_type='invoice' AND $1::text IS NOT NULL
      AND substring(o.nickname from '^(\\d{5,7})\\s')=$1 ORDER BY o.printavo_id`, [store.event_id]),
    pool.query(`SELECT current_step AS "currentStep",version,confirmed_steps AS "confirmedSteps",
      margin_skipped AS "marginSkipped",notes,evidence_key AS "evidenceKey",updated_at AS "updatedAt"
      FROM chipply_setup WHERE store_id=$1`, [storeId]),
  ]);
  const outcomes: Record<string, number> = {};
  for (const line of detail?.lines ?? []) outcomes[line.reconciliation.outcome] = (outcomes[line.reconciliation.outcome] ?? 0) + 1;
  const incomplete = invoices.rows.filter(i => i.detail_sync_state !== "complete" || !i.detail_synced_at ||
    (i.printavo_updated_at && new Date(i.detail_synced_at) < new Date(i.printavo_updated_at))).length;
  const summary = await getStoreSummary(storeId);
  const checks = {
    summaryConflictCount: summary?.summary?.unresolvedCount ?? 0,
    storeName: store.store_name as string, eventId: store.event_id as string | null,
    customerLinked: !!store.pv_customer_id, closedAt: store.closed_at as string | null,
    invoiceCount: invoices.rowCount ?? 0, incompleteInvoiceCount: incomplete,
    missingCategoryCount: invoices.rows.reduce((sum, i) => sum + i.missing, 0),
    marginRowCount: store.margin_rows as number, snapshotId: detail?.snapshotId ?? null,
    orderCount: detail?.summary.orderCount ?? 0, quantity: detail?.summary.quantity ?? 0,
    itemTotalCents: detail?.summary.itemTotalCents ?? 0, outcomes,
  };
  // Do not hash detail fetch timestamps: unchanged resyncs must not revoke approvals.
  const stableInvoices = invoices.rows.map(({ detail_synced_at, printavo_updated_at, ...rest }) => rest);
  const evidenceKey = createHash("sha256").update(JSON.stringify({
    checks, customerId: store.pv_customer_id, invoices: stableInvoices,
    summary: summary?.summary ? [summary.summary.source, summary.summary.comparisons] : null,
    allocations: detail?.lines.map(l => [l.rowOrdinal, l.reconciliation.invoiceId, l.reconciliation.actualMethod, l.reconciliation.outcome]),
  })).digest("hex");
  return { storeId, ...effectiveProgress(progress.rows[0], evidenceKey), evidenceKey, checks };
}