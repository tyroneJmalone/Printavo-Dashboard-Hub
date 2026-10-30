import test from "node:test";
import assert from "node:assert/strict";
import {assertTestScope,assertTestFiles,TEST_ORDER_ID,isTestInvoice} from "../src/lib/printscope/testMode";
test("restricted test guard rejects other invoices, production, automatic actions and unselected files",()=>{
  const s={restrictedTestMode:true,enabled:false,automaticActions:false};
  assert.doesNotThrow(()=>assertTestScope("development",s,TEST_ORDER_ID,false,true));
  assert.doesNotThrow(()=>assertTestScope("development",s,"24912771",false,true));
  assert.equal(isTestInvoice("24912771","23450"),true);
  assert.equal(isTestInvoice("24912771","20625"),false);
  assert.equal(isTestInvoice("23450","23450"),false);
  for(const [env,settings,id,auto,explicit] of [
    ["production",s,TEST_ORDER_ID,false,true],
    ["development",s,"123",false,true],
    ["development",{...s,restrictedTestMode:false},TEST_ORDER_ID,false,true],
    ["development",{...s,enabled:true},TEST_ORDER_ID,false,true],
    ["development",{...s,automaticActions:true},TEST_ORDER_ID,false,true],
    ["development",s,TEST_ORDER_ID,true,true],
    ["development",s,TEST_ORDER_ID,false,false],
  ] as const) assert.throws(()=>assertTestScope(env,settings,id,auto,explicit));
  assert.doesNotThrow(()=>assertTestFiles(["2","1"],[{id:"1"},{id:"2"}]));
  for(const ids of [undefined,[],["1"],["1","1"],["1","3"]]) assert.throws(()=>assertTestFiles(ids,[{id:"1"},{id:"2"}]));
});
import { previewAssetPrefix } from "../src/lib/printscope/assetPaths";
test("preview paths retain bucket and pilot scope for manual and automated originals",()=>{
  const id="11111111-1111-1111-1111-111111111111", token="22222222-2222-2222-2222-222222222222";
  const root="/bucket/.private/printscope/development";
  for(const source of [`${root}/originals/file`,`${root}/automation/123/456/hash.ai`])
    assert.equal(previewAssetPrefix(source,id,token),`${root}/plates/${id}/${token}/`);
  assert.equal(previewAssetPrefix(`${root}/pilots/pilot/originals/file`,id,token),`${root}/pilots/pilot/plates/${id}/${token}/`);
  assert.throws(()=>previewAssetPrefix("/unknown/path",id,token),/SOURCE_SCOPE/);
});
import { automationLogText } from "../../hub/src/pages/printscope/automationLog";
test("scan and action JSON details render readable text rather than objects",()=>{
  const text=automationLogText({held:0,actor:"private-id",error:"'first' must not be greater than 25",
    errors:[],queued:0,invoices:0,unchanged:0,settingsVersion:1});
  assert.equal(typeof text,"string");
  assert.match(text!,/first/);
  assert.match(text!,/0 queued/);
  assert.ok(!text!.includes("private-id"));
  assert.equal(automationLogText({actor:"id",settingsVersion:1}),null);
  assert.equal(automationLogText(null),null);
  assert.equal(automationLogText("Legacy message"),"Legacy message");
  assert.equal(automationLogText({message:"Skipped",errors:["File failed",{unexpected:true}]}),"Skipped\nFile failed");
  assert.equal(automationLogText({note:"Reviewed",steps:[{name:"Archive file",state:"completed"}]}),"Reviewed\nArchive file: completed");
});
import { defaults, outputFilename, scheduleSlot, invoiceFolder, dropboxHash, digest, settingsInput, addedAfterCutoff, invoiceHoldReason, safeDownloadUrl } from "../src/lib/printscope/automationPolicy";
test("Printavo Filepicker CDN is allowed without widening arbitrary download access",()=>{
  assert.equal(safeDownloadUrl("https://cdn.filepicker.io/api/file/example").hostname,"cdn.filepicker.io");
  assert.doesNotThrow(()=>safeDownloadUrl("https://example.cloudfront.net/file"));
  for(const url of ["http://cdn.filepicker.io/file","https://cdn.filepicker.io.evil.test/file","https://evil.filepicker.io/file","https://localhost/file","https://127.0.0.1/file","https://cdn.filepicker.io:8443/file","https://user:pass@cdn.filepicker.io/file"]) assert.throws(()=>safeDownloadUrl(url));
});
test("invoice holds report the actual status or task gate",()=>{
  const inv={status:{id:"1"},prepTasks:[{completed:false}]};
  assert.equal(invoiceHoldReason(inv,["1"]),null);
  assert.match(invoiceHoldReason(inv,["2"])!,/status/);
  assert.match(invoiceHoldReason({...inv,prepTasks:[]},["1"])!,/Missing task/);
  assert.match(invoiceHoldReason({...inv,prepTasks:[{completed:true}]},["1"])!,/already completed/);
  assert.match(invoiceHoldReason({...inv,prepTasks:[{completed:false},{completed:false}]},["1"])!,/Multiple/);
});
test("persistent inclusive upload-date cutoff uses Eastern midnight and fails closed",()=>{
  assert.equal(defaults.addedAfter,"2026-10-27");
  assert.equal(addedAfterCutoff("2026-10-27T03:59:59Z",defaults),false);
  assert.equal(addedAfterCutoff("2026-10-27T04:00:00Z",defaults),true);
  assert.equal(addedAfterCutoff("2026-10-28T23:00:00-04:00",defaults),true);
  assert.equal(addedAfterCutoff("2027-01-01T12:00:00Z",defaults),true);
  for(const value of [null,undefined,"","invalid"])assert.equal(addedAfterCutoff(value,defaults),false);
  assert.equal(addedAfterCutoff("2026-10-28T12:00:00Z",{...defaults,addedAfter:"2026-10-29"}),false);
  const {automaticSince,...s}=defaults;
  for(const addedAfter of ["","2026-02-30","10/28/2026"])assert.equal(settingsInput.safeParse({...s,version:0,addedAfter}).success,false);
});
test("terminal OUTPUT tokens and safe filename boundaries",()=>{
  for(const s of ["OUTPUT.ai","Front_OUTPUT.ai","Back OUtPUT.AI"])assert.ok(outputFilename(s));
  for(const s of ["OUTPUT_old.ai","OUTPUT.pdf","../OUTPUT.ai","NOTOUTPUT.ai","OUTPUT.ai\n"])assert.ok(!outputFilename(s));
});
test("disabled safe defaults and settings validation",()=>{
  assert.equal(defaults.enabled,false);assert.equal(defaults.automaticActions,false);
  assert.deepEqual(defaults.times,["06:30"]);
  const {automaticSince,...s}=defaults;
  assert.ok(settingsInput.safeParse({...s,version:0}).success);
  for(const settleMinutes of [0,1,10,120]) assert.ok(settingsInput.safeParse({...s,version:0,settleMinutes}).success);
  for(const patch of [{times:[]},{times:["24:00"]},{weekdays:[7]},{email:"bad"},{settleMinutes:-1},{settleMinutes:121},{settleMinutes:0.5},{timezone:"bad/zone"}]) assert.ok(!settingsInput.safeParse({...s,version:0,...patch}).success);
});
test("Eastern schedule, extra slots, weekday selection and DST repetition",()=>{
  const s={...defaults,enabled:true,times:["06:30","14:00"]};
  assert.ok(scheduleSlot(s,new Date("2026-07-01T10:30:00Z")));
  assert.ok(scheduleSlot(s,new Date("2026-12-01T11:30:00Z")));
  assert.ok(scheduleSlot(s,new Date("2026-12-01T19:00:00Z")));
  assert.equal(scheduleSlot(s,new Date("2026-12-01T11:31:00Z")),null);
  assert.equal(scheduleSlot({...s,weekdays:[0]},new Date("2026-12-01T11:30:00Z")),null);
  const dst={...s,times:["01:30"]};
  assert.equal(scheduleSlot(dst,new Date("2026-11-01T05:30:00Z")),scheduleSlot(dst,new Date("2026-11-01T06:30:00Z")));
});
test("exact invoice folder prefix and Dropbox content hashing",()=>{
  for(const s of ["#23460","#23460 Job","#23460-Job"])assert.ok(invoiceFolder(s,23460));
  for(const s of ["#234600","#23460A","Job #23460"])assert.ok(!invoiceFolder(s,23460));
  assert.equal(dropboxHash(Buffer.from("abc")),digest(Buffer.from(digest("abc"),"hex")));
  const bytes=Buffer.alloc(4194305,4);
  assert.equal(dropboxHash(bytes),digest(Buffer.concat([Buffer.from(digest(bytes.subarray(0,4194304)),"hex"),Buffer.from(digest(bytes.subarray(4194304)),"hex")])));
});
