import { test } from "node:test";
import assert from "node:assert/strict";
import { reset, state } from "./autoPrintFollowupFixture";
import { previewFollowup, confirmFollowup, listFollowup, reviewFollowup } from "../src/lib/printQueue/autoPrint/followup";
import { followupHash, followupEligibility, followupDisplayState, normalizeFollowupDates } from "../src/lib/printQueue/autoPrint/followupPolicy";
import express from "express";
import { createAutoPrintFollowupRouter } from "../src/routes/autoPrintFollowup";
const log = {} as any;
test("timezone-only changes allow confirmation, genuine changes release the safe pre-write hold",async()=>{
  reset();
  state.node.productionDueAt="2026-10-21T19:00:00-04:00";
  const p=await previewFollowup("run",["job"],"admin");
  state.node.productionDueAt="2026-10-21T23:00:00Z";
  assert.equal((await confirmFollowup(p.previewId,"admin",log)).invoices[0].state,"status_queued");
  reset();
  state.node.productionDueAt="2026-10-21T23:00:00Z";
  const stale=await previewFollowup("run",["job"],"admin");
  state.node.productionDueAt="2026-10-22T00:00:00Z";
  assert.equal((await confirmFollowup(stale.previewId,"admin",log)).invoices[0].state,"blocked");
  assert.equal(state.categoryCalls+state.statusCalls,0);
  assert.equal((await previewFollowup("run",["job"],"admin")).invoices[0].state,"ready");
});
test("known instants normalize without changing descriptions, nulls, invalid dates or source objects",()=>{
  const a={productionDueAt:"2026-10-21T19:00:00-04:00",customerDueAt:null,
    timestamps:{createdAt:"2026-10-12T10:42:43-05:00",updatedAt:"invalid"},
    description:"2026-10-21T19:00:00-04:00"};
  const b=normalizeFollowupDates(a);
  assert.equal(b.productionDueAt,"2026-10-21T23:00:00.000Z");
  assert.equal(b.timestamps.createdAt,"2026-10-12T15:42:43.000Z");
  assert.equal(b.timestamps.updatedAt,"invalid");
  assert.equal(b.customerDueAt,null);
  assert.equal(b.description,a.description);
  assert.equal(a.productionDueAt,"2026-10-21T19:00:00-04:00");
});
test("preview, confirmation, recovery history, and duplicate claim use no print boundary", async()=>{
  reset();
  const p=await previewFollowup("run",["job"],"admin");
  assert.equal(p.invoices[0].state,"ready");
  assert.match(p.invoices[0].categories[0],/5000 Black.*Screen Printing/);
  assert.equal(state.categoryCalls+state.statusCalls,0);
  const result=await confirmFollowup(p.previewId,"admin",log);
  assert.equal(result.invoices[0].state,"status_queued");
  assert.equal(result.state,"status_queued");
  assert.equal(state.categoryCalls,1);assert.equal(state.statusCalls,1);
  assert.equal(state.statusInputs[0].expectedStatusId,"source");
  await assert.rejects(confirmFollowup(p.previewId,"admin",log),/already claimed/);
  assert.equal(state.categoryCalls,1);
  const history=await listFollowup("run");
  assert.equal(history.history[0].invoices[0].state,"updated");
  assert.equal(history.history[0].state,"complete");
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
  assert.equal(result.state,"review_required");
  const next=await previewFollowup("run",["job"],"admin");
  assert.equal(next.invoices[0].state,"blocked");
  assert.match(next.invoices[0].message,/Review & Resolve/);
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
test("finished processing is not mislabeled as successful correction",()=>{
  for(const state of ["blocked","review_required","applying"]){
    assert.equal(followupDisplayState("complete",[{state}]),"review_required");
  }
  assert.equal(followupDisplayState("complete",[{state:"updated"},{state:"status_queued"}]),"status_queued");
  assert.equal(followupDisplayState("complete",[{state:"updated"},{state:"noop"}]),"complete");
});
test("all correction endpoints require admin; invalid or duplicate selections never reach service",async()=>{
  let calls=0;
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{if(req.headers["x-role"])req.staff={role:String(req.headers["x-role"]),email:"admin@test.invalid"} as any;next();});
  app.use(createAutoPrintFollowupRouter({
    listFollowup:async()=>{calls++;return {invoices:[],history:[]};},
    previewFollowup:async()=>{throw Error("must not reach service");},
    confirmFollowup:async()=>{throw Error("must not reach service");},
    reviewFollowup:async()=>{throw Error("must not reach service");},
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
      assert.equal((await fetch(base+"/followup/"+id+"/review",{method:"POST",headers,body:JSON.stringify({jobIds:[id]})})).status,403);
    }
    const headers={"x-role":"admin","content-type":"application/json"};
    assert.equal((await fetch(base+"/runs/"+id+"/followup",{headers})).status,200);
    for(const jobIds of [[],[id,id],Array(21).fill(id),["invalid"]]){
      assert.equal((await fetch(base+"/runs/"+id+"/followup/preview",{method:"POST",headers,body:JSON.stringify({jobIds})})).status,400);
    }
    assert.equal(calls,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
async function heldCorrection() {
  reset();state.unknown=true;
  const p=await previewFollowup("run",["job"],"admin");
  await confirmFollowup(p.previewId,"admin",log);
  state.unknown=false;
  return p;
}
test("held category recovery previews without writes, then applies only missing changes and preserves history",async()=>{
  const original=await heldCorrection();
  const p=await reviewFollowup(original.previewId,["job"],"other-admin");
  assert.equal(p.invoices[0].state,"ready");assert.equal(state.categoryCalls,1);assert.equal(state.statusCalls,0);
  assert.equal(state.claims.get("line").state,"unknown");
  const r=await confirmFollowup(p.previewId,"other-admin",log);
  assert.equal(r.state,"status_queued");assert.equal(state.categoryCalls,2);assert.equal(state.statusCalls,1);
  assert.equal(state.settings.get("autoprint.followup.preview:"+original.previewId).invoices[0].state,"recovery_started");
  await assert.rejects(confirmFollowup(p.previewId,"other-admin",log));
  const history=await listFollowup("run");
  assert.equal(history.history.find(h=>h.previewId===p.previewId)?.state,"complete");
  assert.equal(state.settings.has("autoprint.followup.invoice:invoice"),false);
});
test("already correct category and destination resolve the hold without any upstream writes",async()=>{
  const original=await heldCorrection();
  state.node.lineItemGroups.nodes[0].lineItems.nodes[0].category={id:"cat",name:"Screen Printing"};
  state.live.statusId="target";
  const p=await reviewFollowup(original.previewId,["job"],"admin");
  assert.match(p.invoices[0].categories[0],/Confirmed/);
  const result=await confirmFollowup(p.previewId,"admin",log);
  assert.equal(result.state,"complete");assert.equal(state.categoryCalls,1);assert.equal(state.statusCalls,0);
  assert.equal(state.claims.get("line").state,"updated");
  assert.equal(state.settings.has("autoprint.followup.invoice:invoice"),false);
});
test("changed live data, other category owners and active status submissions block recovery",async()=>{
  for(const change of [
    ()=>state.node.lineItemGroups.nodes[0].lineItems.nodes[0].category={id:"other",name:"Other"},
    ()=>state.claims.get("line").review_id="someone-else",
    ()=>state.live.statusId="progressed",
    ()=>state.config.routingRules[0].statusId="different-target",
    ()=>{state.reviews.values().next().value.state="committing";},
  ]) {
    const original=await heldCorrection();change();
    const p=await reviewFollowup(original.previewId,["job"],"admin");
    assert.equal(p.invoices[0].state,"blocked");
    assert.equal(state.categoryCalls,1);assert.equal(state.statusCalls,0);
  }
  const original=await heldCorrection();
  state.settings.get("autoprint.followup.preview:"+original.previewId).invoices[0].statusJobId="prior-job";
  state.priorStatus={status:"running"};
  const p=await reviewFollowup(original.previewId,["job"],"admin");assert.equal(p.invoices[0].state,"blocked");
});
test("two recovery previews cannot both apply; changed evidence leaves original hold intact",async()=>{
  let original=await heldCorrection();
  const a=await reviewFollowup(original.previewId,["job"],"admin");
  const b=await reviewFollowup(original.previewId,["job"],"admin2");
  await confirmFollowup(a.previewId,"admin",log);
  const blocked=await confirmFollowup(b.previewId,"admin2",log);
  assert.equal(blocked.invoices[0].state,"blocked");assert.equal(state.categoryCalls,2);assert.equal(state.statusCalls,1);
  original=await heldCorrection();
  const preview=await reviewFollowup(original.previewId,["job"],"admin");
  state.node.lineItemGroups.nodes[0].lineItems.nodes[0].items=99;
  assert.equal((await confirmFollowup(preview.previewId,"admin",log)).invoices[0].state,"blocked");
  assert.equal(state.settings.get("autoprint.followup.invoice:invoice").previewId,original.previewId);
});
