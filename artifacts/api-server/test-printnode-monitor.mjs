import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "printnode-monitor-"));
try {
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
import assert from "node:assert/strict";
import { monitorPrintNode } from "./src/lib/printQueue/autoPrint/printNodeMonitor";
import { parsePrintNodeStates, printNodeProblem } from "./src/lib/printQueue/autoPrint/printNodeMonitorPolicy";
import { state } from "@workspace/db";
const log = { warn(){}, error(){} };
const now = new Date();
const entry = (status, time=now.toISOString(), id=123) => ({ printJobId:id,state:status,createTimestamp:time,message:"test detail" });
assert.equal(parsePrintNodeStates([[entry("new","2026-01-01T00:00:00Z"),entry("done")]],["123"],now).get("123").state,"done");
assert.equal(parsePrintNodeStates([[entry("done"),entry("new","2026-01-01T00:00:00Z")]],["123"],now).get("123").state,"done");
assert.equal(parsePrintNodeStates([[entry("error")]],["999"],now).size,0);
assert.throws(()=>parsePrintNodeStates([entry("done")],["123"],now));
assert.throws(()=>parsePrintNodeStates([[{state:"error"}]],["123"],now));
assert.equal(printNodeProblem("done"),false);
assert.equal(printNodeProblem("expired"),true);
process.env.PRINTNODE_API_KEY="test-only";
let gets=0;
globalThis.fetch=async (url,opts) => {
  gets++;
  assert.equal(opts.method,"GET");
  assert.equal(url,"https://api.printnode.com/printjobs/123/states");
  return new Response(JSON.stringify(state.response),{status:200});
};
process.env.REPLIT_DEPLOYMENT="0";
await monitorPrintNode(log); assert.equal(gets,0);
process.env.REPLIT_DEPLOYMENT="1";
state.response=[[entry("error")]];
await monitorPrintNode(log);
assert.equal(state.alerts.size,1);
assert.equal(state.job.snapshotMetadata.printNodeMonitor.state,"error");
assert.equal(state.job.status,"printed");
assert.match([...state.alerts.values()][0].payload.reason,/has not requeued/);
await monitorPrintNode(log); assert.equal(state.alerts.size,1);
state.response=[[entry("done")]];
await monitorPrintNode(log);
assert.equal(state.job.snapshotMetadata.printNodeMonitor.terminal,true);
assert.equal(state.alerts.size,1);
state.response=[];
for(let i=0;i<3;i++) await monitorPrintNode(log);
assert.equal(state.job.snapshotMetadata.printNodeMonitor.state,"unavailable");
assert.equal(state.alerts.size,2);
state.response=[[entry("new")]];
state.job.createdAt=new Date(Date.now()-2*3600_000);
await monitorPrintNode(log);
assert.equal(state.alerts.size,3);
assert.equal(state.job.snapshotMetadata.printNodeMonitor.failures,0);
assert.equal(state.job.status,"printed");
delete process.env.PRINTNODE_API_KEY;
await monitorPrintNode(log);
assert.equal(state.job.snapshotMetadata.printNodeMonitor.state,"unavailable");
assert.ok(state.updates.every(keys => keys.length===1 && keys[0]==="snapshotMetadata"));
console.log("PASS: nested API histories, chronology, malformed data, development guard, GET-only checks, durable observation, deduplicated alerts, outages, delays, and unchanged accepted print status");
` },
    outfile: join(dir, "test.mjs"), platform: "node", format: "esm", bundle: true,
    plugins: [{
      name: "isolated-db",
      setup(b) {
        b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "test" }));
        b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "js", resolveDir: process.cwd(), contents: `
import { pgTable,text,jsonb,timestamp,PgDialect } from "drizzle-orm/pg-core";
export const pqPrintJobsTable=pgTable("jobs", {id:text("id"),runId:text("run_id"),printnodeJobId:text("node"),snapshotMetadata:jsonb("metadata"),createdAt:timestamp("created_at"),printedAt:timestamp("printed_at")});
export const pqPrintRunsTable=pgTable("runs",{id:text("id"),dryRun:text("dry")});
export const pqAdminAlertsTable=pgTable("alerts",{eventKey:text("key")});
export const state={job:{id:"job-1",runId:"run-1",printnodeJobId:"123",createdAt:new Date(),status:"printed",visualId:"22251",printavoOrderId:"test",docType:"workorder",snapshotMetadata:{}},response:[],alerts:new Map(),updates:[]};
const tx={
 execute:async()=>({rows:[{locked:true}]}),
 select:()=>({from:()=>({innerJoin:()=>({where:()=>({orderBy:()=>({limit:async()=>[{job:state.job}]})})})})}),
 update:()=>({set:(changes)=>{state.updates.push(Object.keys(changes));return {where:async()=>{const q=new PgDialect().sqlToQuery(changes.snapshotMetadata);state.job.snapshotMetadata.printNodeMonitor=JSON.parse(q.params.find(p=>typeof p==="string" && p.startsWith("{")));}}}}),
 insert:()=>({values:(v)=>({onConflictDoNothing:async()=>{if(!state.alerts.has(v.eventKey))state.alerts.set(v.eventKey,v);}})})
};
export const db={transaction:async(fn)=>fn(tx)};
` }));
      },
    }],
  });
  await import(pathToFileURL(join(dir, "test.mjs")).href);
} finally { await rm(dir, { recursive: true, force: true }); }
