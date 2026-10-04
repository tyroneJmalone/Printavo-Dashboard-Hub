import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parseSummaryCsv, summaryComparisons, supportedSummary, type SummarySource } from "../src/lib/chipply/summaryImport";
import { previewSummary, confirmSummary, getStoreSummary, retainSummaryValue } from "../src/lib/chipply/summaryService";
import router from "../src/routes/chipplySummary";
import express from "express";

const { Client } = createRequire(process.cwd() + "/../../lib/db/package.json")("pg");
let client: any;
const actor = "fixture@example.invalid";
const source: SummarySource = {
  eventId: "123456", storeName: "Fixture summary name", storeType: "Group", status: "Complete",
  openedAt: "2026-01-01", closedAt: "2026-01-31", productionDueAt: "2026-02-10", shipAt: "2026-02-12",
  contact: "Fixture contact", salesperson: "Fixture salesperson", orders: 12, sales: "123.45", processes: 3, processesWithOrders: 2,
};
before(async () => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  for (const name of ["chipply_stores", "chipply_summary_previews", "chipply_summary_observations"]) {
    // These schemas use UUID defaults, not shared serial sequences.
    await client.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    const namespace = await client.query(`SELECT relnamespace=pg_my_temp_schema() AS safe FROM pg_class WHERE oid=$1::regclass`, [name]);
    assert.equal(namespace.rows[0].safe, true, "Every service write must resolve to temporary fixture tables");
  }
  (globalThis as any).summaryFixtureClient = client;
});
after(async () => { await client?.end(); });

test("uploaded CSV parses read-only: 102 unique records, 100 supported; passwords never retained", () => {
  const path = "../../attached_assets/Chipply_2026_Stores_Summary__1791081200721.csv";
  const csv = readFileSync(path, "utf8");
  const sources = parseSummaryCsv(csv);
  assert.equal(sources.length, 102);
  assert.equal(sources.filter(supportedSummary).length, 100);
  assert.equal(sources.filter(s => s.sales === null).length, 3);
  assert.equal(sources.filter(s => s.orders === 0).length, 3);
  assert.ok(sources.every(s => !("password" in s)));
  const one = csv.split(/\r?\n/).slice(0, 2).join("\n");
  assert.throws(() => parseSummaryCsv(one + "\n" + one.split("\n")[1]), /Duplicate/);
  assert.throws(() => parseSummaryCsv(one.replace("9/14/2026", "2/30/2026")), /invalid open date/);
  assert.throws(() => parseSummaryCsv('Name,Sales\n"broken'), /unterminated/);
  assert.throws(() => parseSummaryCsv("Name,Sales\nExample,10"), /sales order/);
});

test("fill-only import preserves populated values and zero; decisions are evidence-bound; repeat is safe", async () => {
  const id = (await client.query(`INSERT INTO chipply_stores(event_id,store_name,num_orders,total_dollars,org_contact)
    VALUES('123456','Existing name',0,999.99,'   ') RETURNING id`)).rows[0].id;
  const preview = await previewSummary([source], actor, "fixture.csv");
  const compare = preview.rows[0].comparisons;
  assert.equal(compare.find(c => c.field === "orders")?.action, "conflict");
  assert.equal(compare.find(c => c.field === "contact")?.action, "fill");
  assert.equal(compare.find(c => c.field === "sales")?.action, "source");
  const before = (await client.query("SELECT * FROM chipply_stores WHERE id=$1", [id])).rows[0];
  assert.equal(before.opened_at, null, "preview does not fill store fields");
  const saved = await confirmSummary(preview.previewId, [source.eventId], actor);
  assert.equal(saved.stores[0].created, false);
  const store = (await client.query("SELECT *,opened_at::text AS opened FROM chipply_stores WHERE id=$1", [id])).rows[0];
  assert.equal(store.store_name, "Existing name");
  assert.equal(store.num_orders, 0);
  assert.equal(store.total_dollars, "999.99");
  assert.equal(store.opened, "2026-01-01");
  assert.equal(store.org_contact, source.contact);
  let summary = (await getStoreSummary(id))!.summary!;
  assert.equal(summary.unresolvedCount, 2);
  const nameConflict = summary.comparisons.find(c => c.field === "storeName")!;
  await retainSummaryValue(id, nameConflict.field, nameConflict.evidenceKey, actor);
  summary = (await getStoreSummary(id))!.summary!;
  assert.equal(summary.unresolvedCount, 1);
  assert.equal(summary.comparisons.find(c => c.field === "storeName")!.action, "retained");
  assert.equal((await confirmSummary(preview.previewId, [source.eventId], actor)).idempotent, true);
  const repeat = await previewSummary([source], actor, "repeat.csv");
  await confirmSummary(repeat.previewId, [source.eventId], actor);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM chipply_summary_observations WHERE store_id=$1", [id])).rows[0].count, 1);
  await client.query("UPDATE chipply_stores SET store_name='Manually revised' WHERE id=$1", [id]);
  await assert.rejects(retainSummaryValue(id, "storeName", nameConflict.evidenceKey, actor), /changed/);
  assert.equal((await getStoreSummary(id))!.summary!.unresolvedCount, 2);
});

test("stale previews roll back all selected rows, guard scope and enforce actor ownership", async () => {
  const newSource = { ...source, eventId: "111111" };
  const p = await previewSummary([newSource, source], actor, "two.csv");
  await client.query("UPDATE chipply_stores SET salesperson='Changed after preview' WHERE event_id='123456'");
  await assert.rejects(confirmSummary(p.previewId, ["111111", "123456"], actor), /changed after preview/);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM chipply_stores WHERE event_id='111111'")).rows[0].count, 0);
  await assert.rejects(confirmSummary(p.previewId, ["111111"], "other@example.invalid"), /not found/);
  const existing = (await client.query("SELECT id FROM chipply_stores WHERE event_id='123456'")).rows[0].id;
  const scoped = await previewSummary([newSource, source], actor, "scoped.csv", existing);
  assert.equal(scoped.rows.length, 1);
  await assert.rejects(confirmSummary(scoped.previewId, ["111111"], actor), /only supported/);
  await assert.rejects(previewSummary([newSource], actor, "wrong.csv", existing), /does not contain/);
  await client.query("UPDATE chipply_summary_previews SET expires_at=now()-interval '1 hour' WHERE id=$1", [scoped.previewId]);
  await assert.rejects(confirmSummary(scoped.previewId, ["123456"], actor), /expired/);
});

test("new stores are explicit; unsupported batches cannot be imported; blank sales stays null", async () => {
  const s = { ...source, eventId: "234567", sales: null, orders: 0 };
  const batch = { ...source, eventId: "B12345", storeType: "Catalog Batch" };
  const p = await previewSummary([s, batch], actor, "new.csv");
  assert.equal(p.rows[1].supported, false);
  await assert.rejects(confirmSummary(p.previewId, [batch.eventId], actor), /only supported/);
  const result = await confirmSummary(p.previewId, [s.eventId], actor);
  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].created, true);
  const store = (await client.query("SELECT * FROM chipply_stores WHERE event_id='234567'")).rows[0];
  assert.equal(store.num_orders, 0);
  assert.equal(store.total_dollars, null);
  const summary = (await getStoreSummary(store.id))!.summary!;
  assert.equal(summary.source.sales, null);
  assert.equal(summaryComparisons({ ...s, orders: null }, { num_orders: 0 }).find(c => c.field === "orders")?.action, "same");
});

test("routes require staff and validate confirm selection before database access", async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { warn() {}, error() {} }; if (req.headers["x-fixture"]) (req as any).staff = { email: actor }; next(); });
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/chipply/summary`;
  try {
    assert.equal((await fetch(`${base}/preview`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/confirm`, { method: "POST", headers: { "content-type": "application/json", "x-fixture": "1" }, body: JSON.stringify({ previewId: "invalid", selectedSalesOrders: [] }) })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});