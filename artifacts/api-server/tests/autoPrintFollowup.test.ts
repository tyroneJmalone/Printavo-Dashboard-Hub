import { test } from "node:test";
import assert from "node:assert/strict";
import { reset, state } from "./autoPrintFollowupFixture";
import { previewFollowup, confirmFollowup, listFollowup } from "../src/lib/printQueue/autoPrint/followup";
import { followupHash, followupEligibility } from "../src/lib/printQueue/autoPrint/followupPolicy";
import express from "express";
import { createAutoPrintFollowupRouter } from "../src/routes/autoPrintFollowup";
const log = {} as any;
test("preview, confirmation, recovery history, and duplicate claim use no print boundary", async()=>{
  reset();
  const p=await previewFollowup("run",["job"],"admin");
  assert.equal(p.invoices[0].state,"ready");
  assert.match(p.invoices[0].categories[0],/5000 Black.*Screen Printing/);
  assert.equal(state.categoryCalls+state.statusCalls,0);
  const result=await confirmFollowup(p.previewId,"admin",log);
  assert.equal(result.invoices[0].state,"status_queued");
  assert.equal(state.categoryCalls,1);assert.equal(state.statusCalls,1);
  assert.equal(state.statusInputs[0].expectedStatusId,"source");
  await assert.rejects(confirmFollowup(p.previewId,"admin",log),/already claimed/);
  assert.equal(state.categoryCalls,1);
  const history=await listFollowup("run");
  assert.equal(history.history[0].invoices[0].state,"updated");
  assert.equal(state.settings.has("autoprint.followup.invoice:invoice"),false);
});
test("stale details never mutate; changed rules, actor and expiry reject before claim",async()=>{
  reset(); const p=await previewFollowup("run",["job"],"admin");
  await assert.rejects(confirmFollowup(p.previewId,"other-admin",log));
  state.config.routingRules[0].statusId="other";
  await assert.rejects(confirmFollowup(p.previewId,"admin",log));
  state.config.routingRules[0].statusId="target";
  state.node.lineItemGroups.nodes[0].lineItems.nodes[0].items=3;
  const result=await confirmFollowup(p.previewId,"admin",log);
  assert.equal(result.invoices[0].state,"blocked");
  assert.equal(state.categoryCalls+state.statusCalls,0);
  reset(); const exp=await previewFollowup("run",["job"],"admin");
  state.settings.get("autoprint.followup.preview:"+exp.previewId).expiresAt="2000-01-01";
  await assert.rejects(confirmFollowup(exp.previewId,"admin",log));
});
test("uncertain category writes hold invoice and never advance status or resend",async()=>{
  reset(); const p=await previewFollowup("run",["job"],"admin");state.unknown=true;
  const result=await confirmFollowup(p.previewId,"admin",log);
  assert.equal(result.invoices[0].state,"review_required");assert.equal(state.statusCalls,0);
  const next=await previewFollowup("run",["job"],"admin");
  assert.equal(next.invoices[0].state,"blocked");
  assert.match(next.invoices[0].message,/manual verification/);
});
test("concurrent confirm is one-shot",async()=>{
  reset();const p=await previewFollowup("run",["job"],"admin");
  const results=await Promise.allSettled([confirmFollowup(p.previewId,"admin",log),confirmFollowup(p.previewId,"admin",log)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(state.categoryCalls,1);
});
test("progressed invoices, active prints, incomplete details, dry runs and non-MERCH are blocked",async()=>{
  for(const change of [
    ()=>state.live.statusId="completed",
    ()=>state.active=true,
    ()=>state.dryRun=true,
    ()=>state.job.sourceStatusName="PRINT Ordered",
    ()=>state.job.printnodeJobId=null,
    ()=>state.node.lineItemGroups.pageInfo.hasNextPage=true,
    ()=>state.latest={...state.job,id:"newer"},
  ]){
    reset();change();const p=await previewFollowup("run",["job"],"admin");
    assert.equal(p.invoices[0].state,"blocked");
    await confirmFollowup(p.previewId,"admin",log);
    assert.equal(state.categoryCalls+state.statusCalls,0);
  }
});
test("category-only corrections and existing category no-ops",async()=>{
  reset();state.live.statusId="target";
  let p=await previewFollowup("run",["job"],"admin");
  let r=await confirmFollowup(p.previewId,"admin",log);
  assert.equal(r.invoices[0].state,"updated");assert.equal(state.statusCalls,0);
  reset();state.live.statusId="target";state.node.lineItemGroups.nodes[0].lineItems.nodes[0].category={id:"cat",name:"Screen Printing"};
  p=await previewFollowup("run",["job"],"admin");assert.equal(p.invoices[0].state,"noop");
  await confirmFollowup(p.previewId,"admin",log);assert.equal(state.categoryCalls+state.statusCalls,0);
});
test("hash canonicalizes keys without losing line content",()=>{
  assert.equal(followupHash({a:1,b:2}),followupHash({b:2,a:1}));
  assert.notEqual(followupHash({a:[1,2]}),followupHash({a:[2,1]}));
});
test("all correction endpoints require admin; invalid or duplicate selections never reach service",async()=>{
  let calls=0;
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{if(req.headers["x-role"])req.staff={role:String(req.headers["x-role"]),email:"admin@test.invalid"} as any;next();});
  app.use(createAutoPrintFollowupRouter({
    listFollowup:async()=>{calls++;return {invoices:[],history:[]};},
    previewFollowup:async()=>{throw Error("must not reach service");},
    confirmFollowup:async()=>{throw Error("must not reach service");},
  }));
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const id="00000000-0000-4000-8000-000000000001";
  const base=`http://127.0.0.1:${(server.address() as any).port}/print-queue/auto-print`;
  try{
    for(const role of ["staff","manager",""]){
      const headers={"x-role":role,"content-type":"application/json"};
      assert.equal((await fetch(base+"/runs/"+id+"/followup",{headers})).status,403);
      assert.equal((await fetch(base+"/runs/"+id+"/followup/preview",{method:"POST",headers,body:JSON.stringify({jobIds:[id]})})).status,403);
      assert.equal((await fetch(base+"/followup/"+id+"/confirm",{method:"POST",headers})).status,403);
    }
    const headers={"x-role":"admin","content-type":"application/json"};
    assert.equal((await fetch(base+"/runs/"+id+"/followup",{headers})).status,200);
    for(const jobIds of [[],[id,id],Array(21).fill(id),["invalid"]]){
      assert.equal((await fetch(base+"/runs/"+id+"/followup/preview",{method:"POST",headers,body:JSON.stringify({jobIds})})).status,400);
    }
    assert.equal(calls,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
