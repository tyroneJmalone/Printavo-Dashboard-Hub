import { pool } from "@workspace/db";
import type { ParsedData } from "./dataImport";
import { reconcileData, compareProcesses, processSuffix, type MirrorInvoice, type DataOverride } from "./dataReconciliation";
import { compareSplit, evidenceHash } from "./splitReconciliation";

export async function loadDataMirror(event: string, db: Pick<typeof pool, "query"> = pool): Promise<MirrorInvoice[]> {
  const result = await db.query(`SELECT o.printavo_id AS "invoiceId",o.visual_id AS "visualId",o.nickname,o.status_name AS "statusName",
    o.detail_sync_state AS "detailSyncState",o.detail_synced_at AS "detailSyncedAt",o.printavo_updated_at AS "syncedAt",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('style',COALESCE(l.item_number,''),'color',COALESCE(l.color,''),
    'quantity',l.items,'sizes',COALESCE(l.sizes,'[]'::jsonb))) FROM pv_line_items l WHERE l.order_id=o.printavo_id),'[]'::jsonb) AS items
    FROM pv_orders o WHERE o.order_type='invoice' AND substring(o.nickname from '^(\\d{5,7})\\s')=$1`, [event]);
  return result.rows;
}
export async function getChipplyDataDetail(storeId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await readDataDetail(storeId, client);
    await client.query("COMMIT");
    return result;
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}
async function readDataDetail(storeId: string, db: Pick<typeof pool, "query">) {
  const result = await db.query(`SELECT s.*,c.snapshot_id,c.updated_at AS current_revision FROM chipply_data_current c
    JOIN chipply_data_snapshots s ON s.id=c.snapshot_id WHERE c.store_id=$1`, [storeId]);
  if (!result.rowCount) return null;
  const row = result.rows[0], parsed = row.payload as ParsedData;
  // One transaction connection: serialize queries rather than queue concurrent pg calls.
  const invoices = await loadDataMirror(parsed.salesOrder, db);
  const review = await db.query(`SELECT DISTINCT ON (row_ordinal) row_ordinal AS "rowOrdinal",invoice_id AS "invoiceId",reason,actor,created_at AS "createdAt"
      FROM chipply_data_overrides WHERE snapshot_id=$1 ORDER BY row_ordinal,created_at DESC,id DESC`, [row.id]);
  const history = await db.query(`SELECT id,source_hash AS "sourceHash",source_name AS "sourceName",created_at AS "createdAt",actor
      FROM chipply_data_snapshots WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100`, [storeId]);
  const splits = await db.query(`SELECT id,process_key AS "processKey",invoice_ids AS "invoiceIds",evidence_hash AS "evidenceHash",action,reason,actor,created_at AS "createdAt"
      FROM chipply_data_split_reviews WHERE snapshot_id=$1 ORDER BY created_at DESC,id DESC`, [row.id]);
  const lines = reconcileData(parsed.lines, parsed.salesOrder, invoices, review.rows as DataOverride[]);
  const processComparisons = compareProcesses(parsed.lines, parsed.salesOrder, invoices).map(group => {
    const source = parsed.lines.filter(l => processSuffix(l.processName) === group.processKey);
    const candidates = invoices.filter(i => group.candidates.some(c => c.invoiceId === i.invoiceId));
    const hash = evidenceHash({ snapshotId: row.id, revision: row.current_revision, source, candidates,
      overrides: review.rows.filter(o => source.some(l => l.rowOrdinal === o.rowOrdinal)) });
    const saved = splits.rows.find(s => s.processKey === group.processKey);
    const combined = saved?.action === "approve" ? compareSplit(parsed.lines, parsed.salesOrder, group.processKey, invoices, saved.invoiceIds) : null;
    const valid = !!combined?.eligible && saved.evidenceHash === hash;
    if (saved?.action === "approve") {
      for (const line of lines.filter(l => processSuffix(l.processName) === group.processKey)) {
        line.reconciliation = { ...line.reconciliation, invoiceId: null, invoiceVisualId: null,
          actualMethod: valid ? combined!.actualMethod : null, outcome: valid ? "reviewed" : "incomplete",
          splitInvoices: valid ? combined!.invoices : [],
          reason: valid ? "Explicitly reviewed split; complete combined style/color/size coverage and common production method verified. Hub only."
            : "Split review is stale or no longer eligible. Refresh, preview and review again; no split attribution is active." };
      }
    }
    return { ...group, splitEvidence: hash, splitRevision: saved?.id ?? null,
      splitReview: saved ? { ...saved, state: saved.action === "revoke" ? "revoked" as const : valid ? "active" as const : "stale" as const } : null };
  });
  return {
    storeId, snapshotId: row.id as string, sourceHash: parsed.sourceHash, salesOrder: parsed.salesOrder,
    storeName: parsed.storeName, sourceName: row.source_name as string, importedAt: row.created_at,
    summary: parsed.summary, lines, processComparisons,
    splitHistory: splits.rows,
    overrides: review.rows as DataOverride[], versions: history.rows,
    warnings: ["Chipply dollars are separate from Printavo invoice revenue.", "Combined includes Product Price and Process Price; do not add them again.", "Fundraising is not net profit.", "Quantity verification uses current mirrored detail, not a live Printavo fetch."],
  };
}
export type ChipplyDataDetail = NonNullable<Awaited<ReturnType<typeof getChipplyDataDetail>>>;

export interface SplitRequest {
  snapshotId: string; processKey: string; invoiceIds: string[];
  action: "preview" | "approve" | "revoke"; evidence?: string; revision: string | null; reason?: string;
}
export async function reviewChipplySplit(storeId: string, input: SplitRequest, actor: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT snapshot_id FROM chipply_data_current WHERE store_id=$1 FOR UPDATE", [storeId]);
    const detail = await readDataDetail(storeId, client);
    if (!detail || detail.snapshotId !== input.snapshotId) throw new Error("Snapshot changed; refresh before reviewing.");
    const group = detail.processComparisons.find(g => g.processKey === input.processKey);
    if (!group) throw new Error("Process not found.");
    if (group.splitRevision !== input.revision) throw new Error("Another review changed this process; refresh before reviewing.");
    const invoices = await loadDataMirror(detail.salesOrder, client);
    const comparison = compareSplit(detail.lines, detail.salesOrder, input.processKey, invoices, input.invoiceIds);
    // Selection-bound token prevents approving a different set than was previewed.
    const token = evidenceHash({ evidence: group.splitEvidence, invoiceIds: input.invoiceIds, revision: input.revision });
    if (input.action !== "preview") {
      if (!input.reason || input.reason.trim().length < 5) throw new Error("A review reason is required.");
      if (input.action === "approve" && (!comparison.eligible || input.evidence !== token))
        throw new Error("Evidence changed or split is not eligible; preview again.");
      if (input.action === "revoke" && !group.splitReview) throw new Error("No split review to revoke.");
      await client.query(`INSERT INTO chipply_data_split_reviews(snapshot_id,process_key,invoice_ids,evidence_hash,action,reason,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [detail.snapshotId, input.processKey, JSON.stringify(input.invoiceIds),
        group.splitEvidence, input.action, input.reason.trim(), actor]);
    }
    await client.query("COMMIT");
    return { ...comparison, evidence: token };
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}

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
    processComparisons: compareProcesses(parsed.lines, parsed.salesOrder, invoices),
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