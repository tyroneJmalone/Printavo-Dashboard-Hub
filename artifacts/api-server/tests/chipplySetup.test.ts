import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import router from "../src/routes/chipplySetup";
import { effectiveProgress, getSetup } from "../src/lib/chipply/setup";
import { previewChipplyData, confirmChipplyData } from "../src/lib/chipply/dataService";
import type { ParsedData } from "../src/lib/chipply/dataImport";

const id = "10000000-0000-4000-8000-000000000001";
let saved: any;
let customer = true;
let exists = true;
let invoice = false;
let syncedAt = "2026-01-02";
let nickname = "123456 Example PRINT: Front";
function result(rows: any[]) { return { rows, rowCount: rows.length }; }
(globalThis as any).chipplyTestQuery = async (sql: string, args: any[]) => {
  if (sql.includes("FROM chipply_stores s WHERE id")) return result(exists ? [{
    store_name: "Example", event_id: "123456", pv_customer_id: customer ? "customer" : null,
    closed_at: "2026-01-01", margin_rows: 0,
  }] : []);
  if (sql.includes("FROM chipply_data_current")) return result([]);
  if (sql.includes("AS line_hash")) return result(invoice ? [{
    printavo_id: "invoice", nickname, detail_sync_state: "complete",
    detail_synced_at: syncedAt, printavo_updated_at: "2026-01-01", missing: 0, line_hash: "hash",
  }] : []);
  if (sql.includes("FROM chipply_setup")) return result(saved ? [saved] : []);
  if (sql.includes("FROM chipply_stores WHERE id")) return result(exists ? [{ id, event_id: "123456" }] : []);
  if (sql.includes("FROM chipply_summary_observations")) return result([]);
  if (sql.includes("INSERT INTO chipply_setup")) {
    if (saved && saved.version !== args[6]) return result([]);
    saved = { currentStep: args[1], version: (saved?.version ?? 0) + 1,
      confirmedSteps: JSON.parse(args[2]), marginSkipped: args[3], notes: args[4],
      evidenceKey: args[5], updatedAt: "2026-01-01" };
    return result([{ store_id: id }]);
  }
  throw new Error(`Unexpected test query: ${sql.slice(0, 80)}`);
};

test("confirmations are not persisted verification; stale evidence revokes them but preserves notes and resume", () => {
  const saved = { currentStep: 7, version: 3, confirmedSteps: [3, 9], marginSkipped: true,
    notes: "Awaiting correction", evidenceKey: "old", updatedAt: null };
  assert.deepEqual(effectiveProgress(undefined, "key").confirmedSteps, []);
  assert.deepEqual(effectiveProgress(saved, "old").confirmedSteps, [3, 9]);
  const stale = effectiveProgress(saved, "new");
  assert.deepEqual(stale.confirmedSteps, []);
  assert.equal(stale.staleConfirmations, true);
  assert.equal(stale.currentStep, 7);
  assert.equal(stale.notes, saved.notes);
  assert.equal(stale.marginSkipped, true);
});

test("checks report missing data, exclude unchanged resync timestamps, and invalidate real invoice changes", async () => {
  const initial = await getSetup(id);
  assert.equal(initial!.checks.invoiceCount, 0);
  assert.equal(initial!.checks.snapshotId, null);
  invoice = true;
  const current = await getSetup(id);
  syncedAt = "2026-02-01";
  assert.equal((await getSetup(id))!.evidenceKey, current!.evidenceKey);
  nickname = "123456 Corrected PRINT: Front";
  assert.notEqual((await getSetup(id))!.evidenceKey, current!.evidenceKey);
  syncedAt = "2025-01-01";
  assert.equal((await getSetup(id))!.checks.incompleteInvoiceCount, 1);
  invoice = false;
});

test("progress API persists resume, rejects stale saves and changed evidence, validates bounds and requires staff", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {} }; if (req.headers["x-test-staff"]) (req as any).staff = { email: "fixture@example.invalid" }; next(); });
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/chipply/stores/${id}/setup`;
  const headers = { "content-type": "application/json", "x-test-staff": "true" };
  try {
    assert.equal((await fetch(base)).status, 401);
    let state = await (await fetch(base, { headers })).json();
    const body = { version: state.version, evidenceKey: state.evidenceKey, currentStep: 4,
      confirmedSteps: [3], marginSkipped: true, notes: "Test note" };
    assert.equal((await fetch(base, { method: "PUT", headers, body: JSON.stringify(body) })).status, 200);
    state = await (await fetch(base, { headers })).json();
    assert.equal(state.currentStep, 4); assert.equal(state.version, 1);
    assert.equal(state.notes, "Test note"); assert.deepEqual(state.confirmedSteps, [3]);
    assert.equal((await fetch(base, { method: "PUT", headers, body: JSON.stringify(body) })).status, 409);
    customer = false;
    assert.equal((await fetch(base, { method: "PUT", headers, body: JSON.stringify({ ...body, version: 1 }) })).status, 409);
    state = await (await fetch(base, { headers })).json();
    assert.deepEqual(state.confirmedSteps, []); assert.equal(state.staleConfirmations, true);
    assert.equal((await fetch(base, { method: "PUT", headers, body: JSON.stringify({ ...body, currentStep: 10 }) })).status, 400);
    exists = false; assert.equal((await fetch(base, { headers })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("guided imports reject a different store at preview and recheck the binding before confirmation", async () => {
  const old = (globalThis as any).chipplyTestQuery;
  let rolledBack = false;
  (globalThis as any).chipplyTestQuery = async (sql: string) => {
    if (sql.includes("SELECT event_id")) return result([{ event_id: "654321" }]);
    if (sql.includes("SELECT * FROM chipply_data_previews")) return result([{
      payload: { salesOrder: "123456", expectedStoreId: id }, expires_at: "2099-01-01",
    }]);
    if (sql === "ROLLBACK") rolledBack = true;
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return result([]);
    throw new Error("Unexpected write in rejected guided import");
  };
  try {
    await assert.rejects(previewChipplyData({ salesOrder: "123456" } as ParsedData, "fixture", "sample.csv", id), /different sales order/);
    await assert.rejects(confirmChipplyData("preview", "fixture", true), /guided store changed/);
    assert.equal(rolledBack, true);
  } finally { (globalThis as any).chipplyTestQuery = old; }
});