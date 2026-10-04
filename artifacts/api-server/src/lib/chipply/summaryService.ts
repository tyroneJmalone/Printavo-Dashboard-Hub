import { pool } from "@workspace/db";
import { summaryComparisons, summaryFields, summaryHash, supportedSummary, type SummarySource } from "./summaryImport";

type Queryable = Pick<typeof pool, "query">;
const storeSelect = `SELECT id,event_id,store_name,opened_at::text,closed_at::text,org_contact,salesperson,num_orders FROM chipply_stores`;
async function storeFor(q: Queryable, eventId: string, lock = false) {
  return (await q.query(`${storeSelect} WHERE event_id=$1${lock ? " FOR UPDATE" : ""}`, [eventId])).rows[0] ?? null;
}
async function observationFor(q: Queryable, storeId: string | undefined) {
  if (!storeId) return null;
  return (await q.query(`SELECT * FROM chipply_summary_observations WHERE store_id=$1 ORDER BY imported_at DESC,id DESC LIMIT 1`, [storeId])).rows[0] ?? null;
}
function fingerprint(store: Record<string, any> | null, previous: Record<string, any> | null) {
  return summaryHash([store?.id ?? null, store?.event_id ?? null, ...summaryFields.map(f => store?.[f.column] ?? null), previous?.id ?? null]);
}
function review(source: SummarySource, store: Record<string, any> | null, previous: Record<string, any> | null) {
  return { eventId: source.eventId, storeName: source.storeName, storeType: source.storeType,
    supported: supportedSummary(source), storeId: store?.id ?? null, source,
    comparisons: summaryComparisons(source, store, previous?.source_hash === summaryHash(source) ? previous.retained : {}),
  };
}
export async function previewSummary(sources: SummarySource[], actor: string, sourceName: string, expectedStoreId?: string) {
  let scoped = sources;
  if (expectedStoreId) {
    const store = (await pool.query(`${storeSelect} WHERE id=$1`, [expectedStoreId])).rows[0];
    if (!store?.event_id) throw new Error("Link this store's Sales Order number before importing its summary");
    scoped = sources.filter(s => s.eventId === store.event_id);
    if (scoped.length !== 1) throw new Error("This CSV does not contain the guided store's Sales Order");
  }
  const saved = [], rows = [];
  for (const source of scoped) {
    const store = await storeFor(pool, source.eventId);
    const previous = await observationFor(pool, store?.id);
    saved.push({ source, fingerprint: fingerprint(store, previous) });
    rows.push(review(source, store, previous));
  }
  const inserted = await pool.query(`INSERT INTO chipply_summary_previews(actor,source_name,payload,expires_at)
    VALUES($1,$2,$3::jsonb,now()+interval '30 minutes') RETURNING id,expires_at`,
  [actor, sourceName, JSON.stringify({ expectedStoreId: expectedStoreId ?? null, rows: saved })]);
  await pool.query(`DELETE FROM chipply_summary_previews WHERE expires_at < now()-interval '7 days'`);
  return { previewId: inserted.rows[0].id, expiresAt: inserted.rows[0].expires_at, sourceName, rows,
    warnings: [
      "Only blank Hub fields are filled. Existing values, including zero, are never overwritten.",
      "Reported Sales is source-only: its definition has not been verified against Hub financial totals.",
      "Complete is Chipply's status, not proof of production completion. Orders is not garment quantity.",
      "Catalog Batch and unsupported IDs are shown but cannot be imported or linked as Group stores.",
      ...(expectedStoreId ? [`Only the guided store is selected from this ${sources.length}-row CSV.`] : []),
    ] };
}

export async function confirmSummary(previewId: string, selectedSalesOrders: string[], actor: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = (await client.query(`SELECT * FROM chipply_summary_previews WHERE id=$1 AND actor=$2 FOR UPDATE`, [previewId, actor])).rows[0];
    if (!p) throw new Error("Preview not found for this staff member");
    if (p.result) {
      if (JSON.stringify([...selectedSalesOrders].sort()) !== JSON.stringify(p.result.selected)) throw new Error("This preview was already confirmed with a different selection");
      await client.query("COMMIT");
      return { stores: p.result.stores, idempotent: true };
    }
    if (new Date(p.expires_at).getTime() <= Date.now()) throw new Error("Preview expired. Upload the CSV again.");
    const rows = p.payload.rows as { source: SummarySource; fingerprint: string }[];
    const selected = selectedSalesOrders.map(id => {
      const row = rows.find(r => r.source.eventId === id);
      if (!row || !supportedSummary(row.source)) throw new Error("Select only supported Group stores from this preview");
      return row;
    }).sort((a, b) => a.source.eventId.localeCompare(b.source.eventId));
    const stores = [];
    for (const row of selected) {
      const source = row.source;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`chipply-data:${source.eventId}`]);
      let store = await storeFor(client, source.eventId, true);
      const previous = await observationFor(client, store?.id);
      if (fingerprint(store, previous) !== row.fingerprint) throw new Error(`Store ${source.eventId} changed after preview. Upload again to review current values; nothing was saved.`);
      if (p.payload.expectedStoreId && store?.id !== p.payload.expectedStoreId) throw new Error("The guided store identity changed. Refresh and upload again.");
      const created = !store;
      if (!store) {
        const inserted = await client.query(`INSERT INTO chipply_stores(event_id,store_name) VALUES($1,$2)
          ON CONFLICT(event_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING id`, [source.eventId, source.storeName]);
        if (!inserted.rowCount) throw new Error("A store was created concurrently. Upload again; nothing was saved.");
        store = await storeFor(client, source.eventId, true);
      }
      const filledFields: string[] = created ? ["storeName"] : [];
      for (const c of summaryComparisons(source, store)) {
        if (c.action !== "fill") continue;
        const mapping = summaryFields.find(f => f.field === c.field)!;
        // Column names come solely from the fixed allowlist. Defense-in-depth:
        // even under a future refactor, populated values cannot be overwritten.
        const isBlank = ["opened_at", "closed_at", "num_orders"].includes(mapping.column)
          ? `${mapping.column} IS NULL` : `(${mapping.column} IS NULL OR trim(${mapping.column})='')`;
        const filled = await client.query(`UPDATE chipply_stores SET ${mapping.column}=$2,updated_at=now() WHERE id=$1 AND ${isBlank} RETURNING id`, [store.id, c.incoming]);
        if (filled.rowCount) filledFields.push(c.field);
      }
      const hash = summaryHash(source);
      if (previous?.source_hash !== hash) await client.query(`INSERT INTO chipply_summary_observations
        (store_id,source_name,source_hash,source,actor) VALUES($1,$2,$3,$4::jsonb,$5)`,
      [store.id, p.source_name, hash, JSON.stringify(source), actor]);
      stores.push({ eventId: source.eventId, storeId: store.id as string, created, filledFields });
    }
    await client.query(`UPDATE chipply_summary_previews SET result=$2::jsonb WHERE id=$1`, [previewId, JSON.stringify({ selected: [...selectedSalesOrders].sort(), stores })]);
    await client.query("COMMIT");
    return { stores, idempotent: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function getStoreSummary(storeId: string) {
  const store = (await pool.query(`${storeSelect} WHERE id=$1`, [storeId])).rows[0];
  if (!store) return null;
  const previous = await observationFor(pool, storeId);
  // Never show a prior identity's summary as evidence after an event reassignment.
  if (!previous || previous.source.eventId !== store.event_id) return { summary: null };
  const comparisons = summaryComparisons(previous.source, store, previous.retained);
  return { summary: { sourceName: previous.source_name, importedAt: previous.imported_at,
    source: previous.source as SummarySource, comparisons, unresolvedCount: comparisons.filter(c => c.action === "conflict").length } };
}

export async function retainSummaryValue(storeId: string, field: string, evidenceKey: string, actor: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const store = (await client.query(`${storeSelect} WHERE id=$1 FOR UPDATE`, [storeId])).rows[0];
    if (!store) throw new Error("Store not found");
    const previous = await observationFor(client, storeId);
    if (!previous || previous.source.eventId !== store.event_id) throw new Error("Summary identity changed; refresh before deciding");
    const comparison = summaryComparisons(previous.source, store, previous.retained).find(c => c.field === field);
    if (!comparison || !["conflict", "retained"].includes(comparison.action) || comparison.evidenceKey !== evidenceKey) throw new Error("Summary or Hub value changed; refresh before deciding");
    const retained = { ...previous.retained, [field]: { evidenceKey, actor, at: new Date().toISOString() } };
    await client.query(`UPDATE chipply_summary_observations SET retained=$2::jsonb WHERE id=$1`, [previous.id, JSON.stringify(retained)]);
    await client.query("COMMIT");
    return await getStoreSummary(storeId);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}