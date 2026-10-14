import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
if (process.env.REPLIT_DEPLOYMENT === "1") throw Error("Never run fixtures in deployment");
const require = createRequire(path.resolve(import.meta.dirname, "../../lib/db/package.json"));
const { Pool } = require("pg");
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const schema = "search_test_" + randomUUID().replaceAll("-", "");
const client = await db.connect();
try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`CREATE TABLE pq_print_jobs(id uuid,run_id uuid,doc_type text,status text,
    error_message text,reason text,nickname text,visual_id text,printed_at timestamptz,created_at timestamptz);
    CREATE TABLE pq_print_attempts(job_id uuid,started_at timestamptz);
    CREATE TABLE app_settings(key text,value jsonb,updated_at timestamptz);`);
  const run = randomUUID(), job = randomUUID();
  await client.query(`INSERT INTO pq_print_jobs VALUES($1,$2,'workorder','retry_pending',null,null,'Example','23343',null,'2026-01-01')`, [job, run]);
  await client.query(`INSERT INTO pq_print_attempts VALUES($1,'2026-02-01'),($1,'2026-02-02')`, [job]);
  await client.query(`INSERT INTO app_settings VALUES('autoprint.followup.preview:one',$1,'2026-03-01')`, [
    JSON.stringify({runId:run,invoices:[{jobId:job,visualId:"23343",state:"review_required",message:"Needs confirmation"},
      {jobId:"other",visualId:"2334",state:"updated"}]})]);
  const source = readFileSync(path.join(import.meta.dirname, "src/lib/printQueue/autoPrint/invoiceSearch.ts"), "utf8");
  const sql = source.match(/export const invoiceSearchSql = `([\s\S]*?)`;/)[1];
  let rows = (await client.query(sql, ["23343", 0])).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "review_required");
  assert.equal(rows[1].status, "retry_pending");
  assert.equal(rows[1].occurredAt.toISOString(), "2026-02-02T00:00:00.000Z");
  assert.equal((await client.query(sql, ["233", 0])).rowCount, 0);
  assert.equal((await client.query(sql, ["23343' OR true--", 0])).rowCount, 0);
  for (let i=0; i<60; i++) await client.query(
    `INSERT INTO pq_print_jobs VALUES($1,$2,'workorder',$3,null,null,'Example','23343',null,'2025-01-01')`,
    [randomUUID(), run, ["printed","failed","held","submission_unknown","skipped"][i%5]]);
  rows = (await client.query(sql, ["23343", 0])).rows;
  const next = (await client.query(sql, ["23343", 50])).rows;
  assert.equal(rows.length, 51); assert.equal(next.length, 12);
  assert.equal(new Set([...rows.slice(0,50), ...next].map(r=>r.id)).size, 62);
  assert(rows.some(r=>r.status==="printed") && rows.some(r=>r.status==="failed"));
  console.log("PASS: exact invoice search, old correction history, latest attempt time, statuses, injection protection and stable pagination; isolated SQL fixtures only.");
} finally {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  client.release(); await db.end();
}
