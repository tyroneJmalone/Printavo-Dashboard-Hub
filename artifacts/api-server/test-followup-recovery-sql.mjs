import { build } from "esbuild";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { rmSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
if (process.env.REPLIT_DEPLOYMENT === "1") throw Error("Never run this fixture in deployment");
const dbRequire=createRequire(path.resolve(import.meta.dirname,"../../lib/db/package.json"));
const {Pool}=dbRequire("pg");
const db=new Pool({connectionString:process.env.DATABASE_URL});
const schema="recovery_test_"+randomUUID().replaceAll("-","");
const out=path.join(import.meta.dirname,".recovery-sql-test.mjs");
try {
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`CREATE TABLE "${schema}".app_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE "${schema}".chipply_category_claims(line_item_id text PRIMARY KEY,review_id text,state text,updated_at timestamptz DEFAULT now())`);
  globalThis.recoverySqlPool={
    connect:async()=>{const c=await db.connect();await c.query(`SET search_path TO "${schema}"`);return c;},
    query:async(q,p)=>{const c=await globalThis.recoverySqlPool.connect();try{return await c.query(q,p);}finally{c.release();}},
  };
  await build({stdin:{contents:'export {claimRecovery} from "./src/lib/printQueue/autoPrint/followupRecovery";export {followupHash} from "./src/lib/printQueue/autoPrint/followupPolicy";',resolveDir:import.meta.dirname,loader:"ts"},
    outfile:out,bundle:true,format:"esm",platform:"node",plugins:[{name:"isolated-db",setup(b){
      b.onResolve({filter:/^@workspace\/db$/},()=>({path:"db",namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export const pool=globalThis.recoverySqlPool;",loader:"js"}));
    }}]});
  const {claimRecovery,followupHash}=await import(out);
  const q=globalThis.recoverySqlPool.query;
  const entry={jobId:"job",orderId:"order",state:"review_required",message:"fixture"};
  const recovery={parentId:"old",parentHash:followupHash(entry),reviewIds:["review"],categories:[{lineId:"line",targetId:"cat",targetName:"Screen Printing",currentId:null,claimReview:"review",claimState:"unknown"}]};
  async function reset(){
    await q("TRUNCATE app_settings,chipply_category_claims");
    await q("INSERT INTO app_settings(key,value) VALUES($1,$2),($3,$4)",["autoprint.followup.preview:old",JSON.stringify({previewId:"old",runId:"run",state:"complete",invoices:[entry]}),"autoprint.followup.invoice:order",JSON.stringify({previewId:"old"})]);
    await q("INSERT INTO chipply_category_claims VALUES('line','review','unknown',now())");
  }
  await reset();
  const attempts=await Promise.allSettled([claimRecovery(recovery,"job","order","new-a","admin-a"),claimRecovery(recovery,"job","order","new-b","admin-b")]);
  assert.equal(attempts.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await q("SELECT state FROM chipply_category_claims")).rows[0].state,"reconciled");
  assert.equal((await q("SELECT value FROM app_settings WHERE key='autoprint.followup.preview:old'")).rows[0].value.invoices[0].state,"recovery_started");
  await reset();
  await q("UPDATE chipply_category_claims SET review_id='different-owner'");
  await assert.rejects(claimRecovery(recovery,"job","order","new","admin"),/claim changed/);
  assert.equal((await q("SELECT value FROM app_settings WHERE key='autoprint.followup.invoice:order'")).rows[0].value.previewId,"old");
  assert.equal((await q("SELECT value FROM app_settings WHERE key='autoprint.followup.preview:old'")).rows[0].value.invoices[0].state,"review_required");
  await q("UPDATE app_settings SET updated_at='2000-01-01'");
  await q(`INSERT INTO app_settings(key,value) SELECT 'autoprint.followup.preview:new-'||i,
    jsonb_build_object('previewId','new-'||i,'runId','run') FROM generate_series(1,25) i`);
  const source=readFileSync(path.join(import.meta.dirname,"src/lib/printQueue/autoPrint/followup.ts"),"utf8");
  const historySql=source.match(/const saved = await pool\.query\(`([\s\S]*?)`, \[PREFIX/)[1];
  const history=await q(historySql,["autoprint.followup.preview:%","run"]);
  assert.equal(history.rows.length,21);
  assert(history.rows.some(r=>r.value.previewId==="old"));
  console.log("PASS: real PostgreSQL concurrent recovery claims, full rollback and older held-history visibility; isolated tables, no upstream operations.");
} finally {
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.end();rmSync(out,{force:true});
}
