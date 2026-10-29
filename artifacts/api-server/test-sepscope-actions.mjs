import {build} from "esbuild";
import assert from "node:assert/strict";
const providerMock=`
const h=()=>globalThis.__sepHarness;
export async function readInvoice(){return structuredClone(h().invoice);}
export async function downloadOutput(f){return {bytes:Buffer.from("fixture"),sha:h().changed?"changed":"sha"};}
export async function findInvoiceFolder(){return {id:"folder",path:"/Client/#1"};}
export async function liveStatuses(){return [{id:"error",name:"PRINT ERROR - REVIEW"}];}
export async function uploadLink(){return "unused";}
export function archivePath(){return "/Client/#1/file.ai";}
export async function archiveFile(){h().writes.push("archive");if(h().archiveFails)throw Error("archive unavailable");return {id:"archived"};}
`;
await build({entryPoints:["src/lib/printscope/automationActions.ts"],absWorkingDir:import.meta.dirname,outfile:"/tmp/sepscope-actions.mjs",bundle:true,platform:"node",format:"esm",plugins:[{name:"isolated-providers",setup(b){
 b.onResolve({filter:/notificationDelivery|automationProviders|automationStore|\/worker$|printavoGateway|^@workspace\/(db|printavo)$/},a=>({path:a.path,namespace:"mock"}));
 b.onLoad({filter:/.*/,namespace:"mock"},a=>({loader:"js",contents:
 a.path.includes("automationProviders")?providerMock:
 a.path.includes("notificationDelivery")?`export async function deliverNotification(body){globalThis.__sepHarness.writes.push("email:"+body.to);}`:
 a.path.includes("automationStore")?`export async function getSettings(){return {version:1,allowedStatusIds:["source"],settleMinutes:10,...globalThis.__sepHarness.settings};}`:
 a.path.endsWith("worker")?`export const environment=process.env.SEPSCOPE_HARNESS_ENV??"production";`:
 a.path.includes("printavoGateway")?`export function getPrintavoClient(){return {mutate:async q=>{const h=globalThis.__sepHarness;h.writes.push(q);if(q.includes("productionFileDelete")){if(h.deleteFails)throw Error("connection lost");h.invoice.files=[];return {productionFileDelete:{id:"file"}};}if(q==="task"){return {taskUpdate:{completed:true}};}if(q==="status")h.invoice.status.id="error";return {};}}}`:
 a.path==="@workspace/printavo"?`export function statusUpdateMutation(){return "status";}export function taskUpdateMutation(){return "task";}`:
 `export const pool={query:(...args)=>globalThis.__sepHarness.query(...args),connect:async()=>({query:(...args)=>globalThis.__sepHarness.query(...args),release(){}})};`
 }));
}}]});
const {actionPreview,approveActions}=await import("/tmp/sepscope-actions.mjs");
function reset(){
 const h={writes:[],changed:false,archiveFails:false,deleteFails:false,
 invoice:{id:"invoice",visualId:1,customerName:"Fixture",status:{id:"source",name:"Ready"},contact:{customer:{id:"customer"}},prepTasks:[{id:"task",name:"Prep",completed:false}],files:[{id:"file",name:"Front_OUTPUT.ai",timestamps:{updatedAt:"2020-01-01"}}]},
 async query(sql,args){
  if(sql.includes("pg_try"))return {rows:[{locked:true}]};
  if(sql.includes("FROM sepscope_automation_intake"))return {rows:[{job_id:"job",state:"completed",result:{verdict:h.verdict??"pass",completeness:{complete:true}},rule_version_id:1}]};
  if(sql.includes("FROM pv_imprints"))return {rows:[{count:1}]};
  if(sql.startsWith("INSERT"))return {rowCount:1,rows:[{id:"action"}]};
  return {rows:[],rowCount:0};
 }};
 globalThis.__sepHarness=h;return h;
}
let h=reset(), p=await actionPreview("invoice");
await assert.rejects(()=>approveActions("invoice",{token:p.token,decision:"pass",confirmComplete:false,note:""},"actor"),/confirmation/);
assert.deepEqual(h.writes,[]);
h=reset();p=await actionPreview("invoice");h.changed=true;
await assert.rejects(()=>approveActions("invoice",{token:p.token,decision:"pass",confirmComplete:true,note:""},"actor"),/changed/);
assert.deepEqual(h.writes,[]);
h=reset();p=await actionPreview("invoice");h.archiveFails=true;
let result=await approveActions("invoice",{token:p.token,decision:"pass",confirmComplete:true,note:""},"actor");
assert.equal(result.action.state,"review_required");assert.deepEqual(h.writes,["archive"]);
h=reset();p=await actionPreview("invoice");h.deleteFails=true;
result=await approveActions("invoice",{token:p.token,decision:"pass",confirmComplete:true,note:""},"actor");
assert.equal(result.action.state,"review_required");
assert.equal(h.writes.filter(s=>s.includes("productionFileDelete")).length,1);
assert.ok(!h.writes.includes("task"));
h=reset();p=await actionPreview("invoice");
result=await approveActions("invoice",{token:p.token,decision:"pass",confirmComplete:true,note:""},"actor");
assert.equal(result.action.state,"completed");
assert.equal(h.writes[0],"archive");assert.equal(h.writes.at(-1),"task");
console.log("PASS: explicit completeness, stale previews, archive failure retains source, ambiguous deletion has one attempt, archive/verify/delete/task ordering. All providers mocked; no external writes.");
await assert.rejects(()=>approveActions("invoice",{token:p.token,decision:"email",confirmComplete:false,note:"",testMode:true},"actor"),/production/);
process.env.SEPSCOPE_HARNESS_ENV="development";
const dev=await import("/tmp/sepscope-actions.mjs?development");
const testId="21512127";
function testReset(){
  const h=reset();h.settings={restrictedTestMode:true,enabled:false,automaticActions:false,email:"test@example.invalid"};
  h.invoice.id=testId;h.invoice.visualId="20625";return h;
}
h=testReset();p=await dev.actionPreview(testId);
const input={token:p.token,decision:"pass",confirmComplete:true,note:"Test",testMode:true,selectedFileIds:["file"]};
for(const bad of [{...input,testMode:false},{...input,selectedFileIds:[]},{...input,selectedFileIds:["other"]}])
  await assert.rejects(()=>dev.approveActions(testId,bad,"admin"));
await assert.rejects(()=>dev.approveActions("other",input,"admin"));
await assert.rejects(()=>dev.approveActions(testId,input,"admin",true));
assert.deepEqual(h.writes,[]);
h=testReset();h.verdict="fail";p=await dev.actionPreview(testId);
result=await dev.approveActions(testId,{...input,token:p.token,decision:"email"},"admin");
assert.equal(result.action.state,"completed");assert.deepEqual(h.writes,["email:test@example.invalid"]);
h=testReset();h.verdict="fail";p=await dev.actionPreview(testId);
result=await dev.approveActions(testId,{...input,token:p.token,decision:"fail"},"admin");
assert.equal(result.action.state,"completed");assert.deepEqual(h.writes,["status"]);
h=testReset();p=await dev.actionPreview(testId);
result=await dev.approveActions(testId,{...input,token:p.token},"admin");
assert.equal(result.action.state,"completed");assert.equal(h.writes[0],"archive");assert.equal(h.writes.at(-1),"task");
console.log("PASS: restricted dev guards; email-only, status-only and archive/task paths. All external services mocked.");
