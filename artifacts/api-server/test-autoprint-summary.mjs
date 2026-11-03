import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Fixtures must not run in production");
const require = createRequire(resolve(import.meta.dirname, "../../lib/db/package.json"));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const dir = await mkdtemp(join(tmpdir(), "summary-test-"));
const RealDate = Date;
const oldDeployment = process.env.REPLIT_DEPLOYMENT, oldMode = process.env.NODE_ENV;
try {
  await client.query("BEGIN");
  // Temp tables have no copied defaults or production sequences.
  await client.query(`
    CREATE TEMP TABLE pq_print_jobs(id text,run_id text,visual_id text,doc_type text,hub_po_id text,status text,error_message text,created_at timestamptz,printed_at timestamptz,snapshot_metadata jsonb);
    CREATE TEMP TABLE pq_print_runs(id text,status text,dry_run boolean,started_at timestamptz,summary jsonb);
    CREATE TEMP TABLE pq_print_attempts(job_id text,started_at timestamptz,finished_at timestamptz);
    CREATE TEMP TABLE app_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz DEFAULT now());
    INSERT INTO pq_print_runs VALUES('r1','success',false,'2026-11-03T11:30:00Z','{}');
    INSERT INTO pq_print_jobs VALUES
      ('j1','r1','22251','workorder',NULL,'printed',NULL,'2026-11-03T11:30:00Z','2026-11-03T11:31:00Z','{"printNodeMonitor":{"state":"done","observedAt":"2026-11-03T11:32:00Z"}}'),
      ('j2','r1','22251','workorder',NULL,'skipped',NULL,'2026-11-03T11:45:00Z',NULL,'{}'),
      ('j3','r1','22252','workorder',NULL,'printed',NULL,'2026-11-03T11:30:00Z','2026-11-03T11:31:00Z','{"printNodeMonitor":{"state":"error","message":"driver failed","observedAt":"2026-11-03T11:32:00Z"}}'),
      ('old','r1','22251','workorder',NULL,'failed','old failure','2026-11-02T11:30:00Z',NULL,'{}');
  `);
  globalThis.fixturePool = { query: (...args) => client.query(...args),
    connect: async () => ({ query: (sql, args) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)
      ? Promise.resolve({ rows: [] }) : client.query(sql, args), release(){} }) };
  globalThis.mailCalls = [];
  globalThis.mailFails = false;
  await build({
    stdin: { resolveDir: import.meta.dirname, contents: `
      export * from "./src/lib/printQueue/autoPrint/currentStatus";
      export * from "./src/lib/printQueue/autoPrint/summaryEmailPolicy";
      export * from "./src/lib/printQueue/autoPrint/summaryEmails";
    ` },
    outfile: join(dir, "test.mjs"), bundle: true, platform: "node", format: "esm",
    plugins: [{ name: "safe-test-services", setup(b) {
      b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "fixture" }));
      b.onResolve({ filter: /^@replit\/connectors-sdk$/ }, () => ({ path: "mail", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path === "db"
        ? "export const pool=globalThis.fixturePool;"
        : `export class ReplitConnectors {async proxy(provider,path,options) {
          globalThis.mailCalls.push({provider,path,options});
          if(globalThis.mailFails) throw new Error("simulated lost acknowledgement");
          return new Response(JSON.stringify({id:"test-message"}),{status:200});
        }}` }));
    } }],
  });
  const mod = await import(pathToFileURL(join(dir, "test.mjs")).href);
  assert.equal(mod.summaryEmailSlot(new Date("2026-07-01T12:01:00Z")).end.toISOString(), "2026-07-01T12:00:00.000Z");
  assert.equal(mod.summaryEmailSlot(new Date("2026-11-03T13:01:00Z")).end.toISOString(), "2026-11-03T13:00:00.000Z");
  assert.equal(mod.summaryEmailSlot(new Date("2026-11-01T13:01:00Z")).start.toISOString(), "2026-10-31T18:00:00.000Z");
  assert.equal(mod.summaryEmailSlot(new Date("2026-03-08T12:01:00Z")).start.toISOString(), "2026-03-07T19:00:00.000Z");
  assert.equal(mod.summarySlotDue(new Date("2026-11-03T14:00:00Z"),new Date("2026-11-02")),null);
  assert.equal(mod.summarySlotDue(new Date("2026-11-03T13:01:00Z"),new Date("2026-11-03T13:00:30Z")),null);
  let statuses = await mod.currentInvoiceStatuses(["22251","22252","999"]);
  assert.equal(statuses.get("22251").status,"SUCCESS"); // newer skip cannot mask accepted output
  assert.equal(statuses.get("22252").status,"FAILED"); // accepted but downstream failure
  assert.equal(statuses.get("999").status,"NO HISTORY");
  const evidence={visualId:"1",jobId:"x",runId:"r",kind:"workorder",status:"printed",message:null,occurredAt:"2026-11-03",monitor:null};
  assert.equal(mod.describeCurrentEvidence({...evidence,monitor:{state:"unavailable"}}).status,"NEEDS REVIEW");
  assert.equal(mod.describeCurrentEvidence({...evidence,status:"submission_unknown"}).status,"NEEDS REVIEW");
  assert.equal(mod.describeCurrentEvidence({...evidence,status:"retry_pending"}).status,"PENDING");
  assert.equal(mod.describeCurrentEvidence({...evidence,status:"dry_run"}).status,"SIMULATED");
  await client.query(`INSERT INTO app_settings VALUES
    ('autoprint.followup.preview:p','{"previewId":"p","runId":"r1","invoices":[{"orderId":"o1","jobId":"j1","visualId":"22251","state":"review_required","message":"Category needs review"}]}',now()),
    ('autoprint.followup.invoice:o1','{"previewId":"p"}',now())`);
  statuses=await mod.currentInvoiceStatuses(["22251"]);
  assert.equal(statuses.get("22251").status,"NEEDS REVIEW");
  await client.query(`DELETE FROM app_settings WHERE key='autoprint.followup.invoice:o1'`);
  assert.equal((await mod.currentInvoiceStatuses(["22251"])).get("22251").status,"SUCCESS");
  const summary=await mod.buildAutoPrintSummary(new Date("2026-11-02T19:00:00Z"),new Date("2026-11-03T13:00:00Z"));
  assert.match(summary.text,/#22251: SUCCESS/); assert.match(summary.text,/#22252: FAILED/);
  assert.match(summary.text,/Distinct invoices: 2/);
  const log={error(){},info(){}};
  await mod.sendAutoPrintSummaries(log);
  assert.equal(globalThis.mailCalls.length,0);
  let clock = new RealDate("2026-11-03T13:00:10Z").getTime();
  globalThis.Date=class extends RealDate { constructor(...args){ super(...(args.length?args:[clock])); } static now(){return clock;} };
  process.env.REPLIT_DEPLOYMENT="1"; process.env.NODE_ENV="production";
  await client.query(`INSERT INTO app_settings(key,value) VALUES('autoprint.summary-email-started','{"since":"2026-11-02T00:00:00Z"}')`);
  globalThis.mailFails=true;
  await mod.sendAutoPrintSummaries(log);
  assert.equal(globalThis.mailCalls.length,1);
  const original = globalThis.mailCalls[0].options;
  clock+=6*60_000; globalThis.mailFails=false;
  await mod.sendAutoPrintSummaries(log);
  assert.equal(globalThis.mailCalls.length,2);
  assert.equal(globalThis.mailCalls[1].options.body,original.body);
  assert.equal(globalThis.mailCalls[1].options.headers["Idempotency-Key"],original.headers["Idempotency-Key"]);
  assert.equal(JSON.parse(original.body).to,"it@mintprintworks.com");
  await mod.sendAutoPrintSummaries(log); assert.equal(globalThis.mailCalls.length,2);
  assert.equal((await mod.summaryEmailStatus()).deliveries[0].state,"sent");
  console.log("PASS: current outcome SQL, skips/old failures, PrintNode errors, correction holds, no history, DST windows, no catch-up, summary counts, production guard, frozen retries and email deduplication. No real emails sent.");
} finally {
  globalThis.Date=RealDate;
  if(oldDeployment===undefined) delete process.env.REPLIT_DEPLOYMENT; else process.env.REPLIT_DEPLOYMENT=oldDeployment;
  if(oldMode===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=oldMode;
  await client.query("ROLLBACK"); client.release(); await pool.end(); await rm(dir,{recursive:true,force:true});
}
