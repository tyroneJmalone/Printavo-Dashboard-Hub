/**
 * Explicit development-only integration harness. Not imported by the API.
 * Auth substitution exists only on an ephemeral loopback listener in this process.
 * Exercises real GCS, Drizzle database, route handlers and isolated Python worker.
 */
import express from "express";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pool } from "@workspace/db";
import router from "../src/routes/printscope";
import { activeRules, pythonRoot } from "../src/lib/printscope/rules";
import { processOne, probePrintscope, objectFile, environment } from "../src/lib/printscope/worker";

if (environment !== "development") throw new Error("This harness is development-only");
const fixtureDir = process.env.PRINTSCOPE_FIXTURES ?? "/tmp/printscope-041.yKnzqb/printscope-fixtures";
const goldenDir = resolve(pythonRoot(), "printscope-engine/golden");
const manifest = JSON.parse(await readFile(resolve(goldenDir, "MANIFEST.json"), "utf8"));
const fixtureRows = manifest.fixtures as { filename: string; golden: string; sha256: string; bytes: number }[];
const current = await activeRules();
const baselineCsv = await readFile(resolve(pythonRoot(), "printscope-engine/printscope-rules-v2.csv"), "utf8");
assert.equal(current.hash, createHash("sha256").update(baselineCsv).digest("hex"), "Active rules differ from baseline; do not mutate globally");
assert.equal((await probePrintscope()).available, true, "Real worker capabilities unavailable");
const staffId = (await pool.query("SELECT id FROM staff_users ORDER BY created_at LIMIT 1")).rows[0]?.id ?? randomUUID();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.staff = { id: staffId, role: "admin" } as any;
  next();
});
app.use("/api", router);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(ok => server.once("listening", ok));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api/printscope`;
const created: string[] = [], staging: string[] = [];
let primaryId: string | undefined;
const report: any = { startedAt: new Date().toISOString(), fixtures: [], rerun: null, preservedJobId: null, cleanedJobs: 0 };
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `HTTP ${response.status} on ${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function readResult(id: string) {
  const result = await request(`/jobs/${id}`);
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.ok(!("sourcePath" in result) && !("source_path" in result));
  return result;
}
try {
  for (const [index, fixture] of fixtureRows.entries()) {
    const began = Date.now();
    const bytes = await readFile(resolve(fixtureDir, fixture.filename));
    assert.equal(bytes.length, fixture.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
    const reservation = await request("/uploads", "POST", { filename: `Genuine fixture validation - ${fixture.filename}`, byteSize: bytes.length, contentType: "application/pdf" });
    const id = reservation.job.id; created.push(id);
    const stored = (await pool.query("SELECT source_path FROM printscope_jobs WHERE id=$1", [id])).rows[0];
    staging.push(stored.source_path);
    const put = await fetch(reservation.uploadURL, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes });
    assert.ok(put.ok, `Signed upload failed HTTP ${put.status}`);
    const queued = await request(`/jobs/${id}/complete`, "POST");
    assert.equal(queued.state, "queued"); assert.equal(queued.sha256, fixture.sha256);
    await processOne(id);
    const detail = await readResult(id);
    const assetRows = (await pool.query("SELECT assets FROM printscope_jobs WHERE id=$1", [id])).rows[0].assets;
    for (const asset of Object.values(assetRows) as any[]) {
      assert.match(asset.generation, /^\d+$/);
      const [metadata] = await objectFile(asset.path, asset.generation).getMetadata();
      assert.equal(String(metadata.generation), asset.generation);
    }
    if (index === 0) { primaryId = id; report.preservedJobId = id; }
    const expected = JSON.parse(await readFile(resolve(goldenDir, fixture.golden), "utf8"));
    assert.equal(detail.result.verdict, expected.verdict);
    assert.deepEqual(detail.result.completeness, expected.completeness);
    assert.deepEqual(Object.fromEntries(detail.result.results.map((r: any) => [r.code, r.status])), Object.fromEntries(expected.results.map((r: any) => [r.code, r.status])));
    let plates = 0;
    for (const board of detail.result.previews) for (const plate of board.plates ?? []) {
      const response = await fetch(`http://127.0.0.1:${port}${plate.src}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^image\/(svg\+xml|png)/);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
      plates++;
    }
    assert.equal((await fetch(base + `/jobs/${id}/plates/${randomUUID()}`)).status, 404);
    report.fixtures.push({ fixture: fixture.filename, verdict: detail.result.verdict, complete: detail.result.completeness.complete, statusesMatched: detail.result.results.length, privatePlatesRead: plates, seconds: Math.round((Date.now() - began) / 1000) });
    console.info(`Fixture ${index + 1}/${fixtureRows.length}: verdict/status/completeness and ${plates} private plates matched`);
    await writeFile("/tmp/printscope-integration-report.json", JSON.stringify(report, null, 2));
  }
  const original = await readResult(primaryId!);
  const rerun = await request(`/jobs/${primaryId}/reinspect`, "POST"); created.push(rerun.id);
  assert.notEqual(rerun.id, primaryId); assert.equal(rerun.sha256, original.sha256);
  assert.equal(rerun.parentJobId, primaryId); assert.equal(rerun.ruleVersionId, current.id);
  const sources = (await pool.query("SELECT source_path,generation FROM printscope_jobs WHERE id=ANY($1::uuid[])", [[primaryId, rerun.id]])).rows;
  assert.deepEqual(sources[0], sources[1]);
  await processOne(rerun.id);
  const again = await readResult(rerun.id);
  assert.equal(again.result.verdict, original.result.verdict);
  assert.deepEqual(again.result.completeness, original.result.completeness);
  assert.deepEqual(Object.fromEntries(again.result.results.map((r: any) => [r.code, r.status])), Object.fromEntries(original.result.results.map((r: any) => [r.code, r.status])));
  assert.deepEqual((await readResult(primaryId!)).result, original.result);
  const originalAsset = original.result.previews.flatMap((b: any) => b.plates ?? [])[0]?.src?.split("/").pop();
  if (originalAsset) assert.equal((await fetch(base + `/jobs/${rerun.id}/plates/${originalAsset}`)).status, 404);
  report.rerun = { newId: true, originalGenerationShared: true, oldResultUnchanged: true, resultMatched: true, crossJobAssetRejected: true };
} finally {
  // Only exact IDs/paths produced in this invocation. Preserve primary source and plates.
  const originals = await pool.query("SELECT id,source_path,assets FROM printscope_jobs WHERE id=ANY($1::uuid[])", [created]);
  const preserved = originals.rows.find(r => r.id === primaryId);
  const deletePaths = new Set<string>(staging);
  for (const row of originals.rows) if (row.id !== primaryId) {
    if (row.source_path !== preserved?.source_path) deletePaths.add(row.source_path);
    for (const asset of Object.values(row.assets ?? {}) as any[]) deletePaths.add(asset.path);
  }
  for (const path of deletePaths) await objectFile(path).delete({ ignoreNotFound: true }).catch(() => { report.cleanupObjectFailures = (report.cleanupObjectFailures ?? 0) + 1; });
  const cleanupIds = created.filter(id => id !== primaryId);
  await pool.query("DELETE FROM printscope_jobs WHERE id=ANY($1::uuid[])", [cleanupIds]);
  report.cleanedJobs = cleanupIds.length;
  report.finishedAt = new Date().toISOString();
  await writeFile("/tmp/printscope-integration-report.json", JSON.stringify(report, null, 2));
  server.close(); await pool.end();
}
console.info(JSON.stringify(report, null, 2));