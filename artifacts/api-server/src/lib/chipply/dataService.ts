import { pool } from "@workspace/db";
import type { ParsedData } from "./dataImport";
import { reconcileData, type MirrorInvoice, type DataOverride } from "./dataReconciliation";

export async function loadDataMirror(event: string): Promise<MirrorInvoice[]> {
  const result = await pool.query(`SELECT o.printavo_id AS "invoiceId",o.nickname,o.status_name AS "statusName",
    o.detail_sync_state AS "detailSyncState",o.detail_synced_at AS "detailSyncedAt",o.printavo_updated_at AS "syncedAt",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('style',COALESCE(l.item_number,''),'color',COALESCE(l.color,''),
    'quantity',l.items,'sizes',COALESCE(l.sizes,'[]'::jsonb))) FROM pv_line_items l WHERE l.order_id=o.printavo_id),'[]'::jsonb) AS items
    FROM pv_orders o WHERE o.order_type='invoice' AND substring(o.nickname from '^(\\d{5,7})\\s')=$1`, [event]);
  return result.rows;
}
export async function getChipplyDataDetail(storeId: string) {
  const result = await pool.query(`SELECT s.*,c.snapshot_id FROM chipply_data_current c
    JOIN chipply_data_snapshots s ON s.id=c.snapshot_id WHERE c.store_id=$1`, [storeId]);
  if (!result.rowCount) return null;
  const row = result.rows[0], parsed = row.payload as ParsedData;
  const [invoices, review, history] = await Promise.all([
    loadDataMirror(parsed.salesOrder),
    pool.query(`SELECT DISTINCT ON (row_ordinal) row_ordinal AS "rowOrdinal",invoice_id AS "invoiceId",reason,actor,created_at AS "createdAt"
      FROM chipply_data_overrides WHERE snapshot_id=$1 ORDER BY row_ordinal,created_at DESC,id DESC`, [row.id]),
    pool.query(`SELECT id,source_hash AS "sourceHash",source_name AS "sourceName",created_at AS "createdAt",actor
      FROM chipply_data_snapshots WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100`, [storeId]),
  ]);
  return {
    storeId, snapshotId: row.id as string, sourceHash: parsed.sourceHash, salesOrder: parsed.salesOrder,
    storeName: parsed.storeName, sourceName: row.source_name as string, importedAt: row.created_at,
    summary: parsed.summary, lines: reconcileData(parsed.lines, parsed.salesOrder, invoices, review.rows as DataOverride[]),
    overrides: review.rows as DataOverride[], versions: history.rows,
    warnings: ["Chipply dollars are separate from Printavo invoice revenue.", "Combined includes Product Price and Process Price; do not add them again.", "Fundraising is not net profit.", "Quantity verification uses current mirrored detail, not a live Printavo fetch."],
  };
}
export type ChipplyDataDetail = NonNullable<Awaited<ReturnType<typeof getChipplyDataDetail>>>;

export async function previewChipplyData(parsed: ParsedData, actor: string, sourceName: string, expectedStoreId?: string) {
  if (expectedStoreId) {
    const scope = await pool.query("SELECT event_id FROM chipply_stores WHERE id=$1", [expectedStoreId]);
    if (!scope.rowCount || scope.rows[0].event_id !== parsed.salesOrder) {
      throw new Error("This export belongs to a different sales order than this setup guide. Check the store event number and upload its complete export.");
    }
  }
  const existing = await pool.query(`SELECT s.id,s.store_name,c.snapshot_id FROM chipply_stores s
    LEFT JOIN chipply_data_current c ON c.store_id=s.id WHERE s.event_id=$1`, [parsed.salesOrder]);
  const store = existing.rows[0];
  const invoices = await loadDataMirror(parsed.salesOrder);
  const result = await pool.query(`INSERT INTO chipply_data_previews(actor,source_name,payload,expected_snapshot_id,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '30 minutes') RETURNING id,expires_at`, [actor, sourceName, JSON.stringify({ ...parsed, ...(expectedStoreId ? { expectedStoreId } : {}) }), store?.snapshot_id ?? null]);
  // Preview content contains only the same bounded normalized data as snapshots.
  await pool.query("DELETE FROM chipply_data_previews WHERE expires_at < now() - interval '1 day'");
  return { previewId: result.rows[0].id as string, expiresAt: result.rows[0].expires_at,
    salesOrder: parsed.salesOrder, storeName: parsed.storeName, sourceHash: parsed.sourceHash,
    existingStore: store ? { id: store.id, storeName: store.store_name } : null,
    detectedInvoiceCount: invoices.length, currentSnapshotId: store?.snapshot_id ?? null,
    requiresReplacement: !!store?.snapshot_id, summary: parsed.summary,
    lines: reconcileData(parsed.lines, parsed.salesOrder, invoices),
    warnings: ["This is a complete snapshot, not a delta. Confirming replacement removes absent lines from current totals while retaining previous versions.", "Buyer names, contacts, addresses and free-text answers are not retained.", "Fundraising is not net profit; Combined is not additive with Product/Process Price."] };
}
export async function confirmChipplyData(previewId: string, actor: string, replaceCurrent: boolean) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = await client.query("SELECT * FROM chipply_data_previews WHERE id=$1 AND actor=$2 FOR UPDATE", [previewId, actor]);
    if (!p.rowCount) throw new Error("Preview not found for this staff member");
    const preview = p.rows[0], parsed = preview.payload as ParsedData;
    if (new Date(preview.expires_at).getTime() < Date.now()) throw new Error("Preview expired; upload again");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`chipply-data:${parsed.salesOrder}`]);
    const expectedStoreId = (preview.payload as ParsedData & { expectedStoreId?: string }).expectedStoreId;
    if (expectedStoreId) {
      const scope = await client.query("SELECT event_id FROM chipply_stores WHERE id=$1 FOR UPDATE", [expectedStoreId]);
      if (!scope.rowCount || scope.rows[0].event_id !== parsed.salesOrder) throw new Error("The guided store changed after preview. Reopen the guide and upload again.");
    }
    const s = await client.query(`INSERT INTO chipply_stores(event_id,store_name) VALUES($1,$2)
      ON CONFLICT(event_id) WHERE event_id IS NOT NULL DO UPDATE SET event_id=EXCLUDED.event_id RETURNING id`, [parsed.salesOrder, parsed.storeName]);
    const storeId = s.rows[0].id as string;
    const c = await client.query("SELECT snapshot_id FROM chipply_data_current WHERE store_id=$1 FOR UPDATE", [storeId]);
    const currentId = c.rows[0]?.snapshot_id ?? null;
    const same = await client.query("SELECT id FROM chipply_data_snapshots WHERE store_id=$1 AND source_hash=$2", [storeId, parsed.sourceHash]);
    if (same.rows[0]?.id === currentId) { await client.query("COMMIT"); return { storeId, snapshotId: currentId as string, idempotent: true }; }
    if (currentId !== preview.expected_snapshot_id) throw new Error("Current snapshot changed after preview; upload again");
    if (currentId && !replaceCurrent) throw new Error("Explicit replaceCurrent confirmation required");
    const snapshot = same.rows[0] ?? (await client.query(`INSERT INTO chipply_data_snapshots(store_id,source_hash,source_name,payload,actor)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [storeId, parsed.sourceHash, preview.source_name, JSON.stringify(parsed), actor])).rows[0];
    await client.query(`INSERT INTO chipply_data_current(store_id,snapshot_id) VALUES($1,$2)
      ON CONFLICT(store_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,updated_at=now()`, [storeId, snapshot.id]);
    await client.query("INSERT INTO chipply_data_events(store_id,previous_snapshot_id,snapshot_id,actor) VALUES($1,$2,$3,$4)", [storeId, currentId, snapshot.id, actor]);
    await client.query("UPDATE chipply_data_previews SET confirmed_snapshot_id=$2 WHERE id=$1", [previewId, snapshot.id]);
    await client.query("COMMIT");
    return { storeId, snapshotId: snapshot.id as string, idempotent: false };
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}
export async function overrideChipplyData(storeId: string, snapshotId: string, rowOrdinal: number, invoiceId: string, reason: string, actor: string) {
  const detail = await getChipplyDataDetail(storeId);
  if (!detail || detail.snapshotId !== snapshotId) throw new Error("Snapshot changed; refresh before reviewing");
  const line = detail.lines.find(l => l.rowOrdinal === rowOrdinal);
  if (!line?.reconciliation.candidateInvoiceIds.includes(invoiceId)) throw new Error("Invoice must match this event and process suffix");
  // Only selection is overridden. Quantity and method evidence remain required on every read.
  const result = await pool.query(`INSERT INTO chipply_data_overrides(snapshot_id,row_ordinal,invoice_id,reason,actor)
    SELECT $2,$3,$4,$5,$6 FROM chipply_data_current WHERE store_id=$1 AND snapshot_id=$2 RETURNING id`,
  [storeId, snapshotId, rowOrdinal, invoiceId, reason, actor]);
  if (!result.rowCount) throw new Error("Snapshot changed; refresh before reviewing");
  return getChipplyDataDetail(storeId);
}