import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { transform } from "esbuild";
if (process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production") throw Error("Development fixtures only");
const require = createRequire(path.resolve(import.meta.dirname, "../../lib/db/package.json"));
const { Pool } = require("pg");
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await db.connect();
const schema = "email_test_" + randomUUID().replaceAll("-", "");
const source = readFileSync(new URL("src/lib/printQueue/autoPrint/failureEmails.ts", import.meta.url), "utf8");
const query = source.match(/pool\.query<FailureEmail>\(`([\s\S]*?)`, \[since, PREFIX\]\)/)[1];
const code = await transform(readFileSync(new URL("src/lib/printQueue/autoPrint/emailPolicy.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "esm" });
const { failureEmailBody, emailRetryWindowOpen } = await import("data:text/javascript;base64," + Buffer.from(code.code).toString("base64"));
assert(emailRetryWindowOpen(new Date().toISOString()));
assert(!emailRetryWindowOpen(new Date(Date.now()-24*3600000).toISOString()));
assert(!emailRetryWindowOpen("invalid"));
const body = failureEmailBody({ title:"Category review", key:"test", invoice:"23363", at:new Date().toISOString(), reason:"Blank category" });
assert(body.subject.includes("#23363") && body.text.includes("Blank category") && body.text.includes("Eastern"));
const prefix = "autoprint.failure-email:";
try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE app_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE pq_print_runs(id uuid,dry_run boolean);
    CREATE TABLE pq_print_jobs(id uuid,run_id uuid,printavo_order_id text,visual_id text,printed_at timestamptz,
      status text,doc_type text,target_status_id text,source_status_id text,source_status_name text,snapshot_metadata jsonb);
    CREATE TABLE pv_orders(printavo_id text,status_id text);
    CREATE TABLE pq_status_jobs(id uuid,trigger text,state jsonb,updated_at timestamptz DEFAULT now());
  `);
  const job=randomUUID(), run=randomUUID(), status=randomUUID();
  await client.query("INSERT INTO pq_print_runs VALUES($1,false)",[run]);
  await client.query("INSERT INTO pv_orders VALUES('order','source')");
  await client.query(`INSERT INTO pq_print_jobs VALUES($1,$2,'order','23363',now(),'printed','workorder',null,
    'source','MERCH - Ordered','{"durableRetry":{"routingPrepared":true}}')`,[job,run]);
  await client.query(`INSERT INTO app_settings(key,value) VALUES('pq_autoprint_config',
    '{"routingMode":"conditional","routingRules":[{"enabled":true}]}')`);
  const scan = () => client.query(query, ["2026-01-01",prefix]).then(r=>r.rows);
  let rows=await scan();
  assert.equal(rows.length,1); assert.equal(rows[0].key,`mapping:${job}`);
  await client.query("UPDATE pq_print_runs SET dry_run=true");
  assert.equal((await scan()).length,0);
  await client.query("UPDATE pq_print_runs SET dry_run=false");
  await client.query("INSERT INTO app_settings(key,value) VALUES($1,'{\"state\":\"sent\"}')",[prefix+`mapping:${job}`]);
  assert.equal((await scan()).length,0);
  const state={status:"failed",lines:[{orderId:"order",visualId:23363,status:"failed",targetStatusId:"target",error:"Read failed"}]};
  await client.query("INSERT INTO pq_status_jobs(id,trigger,state) VALUES($1,'autoprint',$2)",[status,state]);
  rows=await scan(); assert.equal(rows.length,1); assert.equal(rows[0].reason,"Read failed");
  await client.query("UPDATE pv_orders SET status_id='target'");
  assert.equal((await scan()).length,0);
  await client.query("UPDATE pq_status_jobs SET trigger='manual'");
  await client.query("UPDATE pv_orders SET status_id='source'");
  assert.equal((await scan()).length,0);
  await client.query(`INSERT INTO app_settings(key,value) VALUES
    ('autoprint.followup.preview:test',$1),('autoprint.followup.invoice:order','{"previewId":"test"}')`,[
      {previewId:"test",state:"complete",invoices:[{jobId:job,orderId:"order",visualId:"23363",state:"review_required",message:"Category unconfirmed"}]}]);
  rows=await scan(); assert.equal(rows.length,1); assert.equal(rows[0].reason,"Category unconfirmed");
  await client.query("DELETE FROM app_settings WHERE key='autoprint.followup.invoice:order'");
  assert.equal((await scan()).length,0);
  console.log("PASS: missing mappings, dry-run exclusion, durable deduplication, asynchronous status failures, resolved statuses, manual-job exclusion, held category corrections, released holds, message formatting, idempotency window.");
} finally {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  client.release(); await db.end();
}
