import test from "node:test";
import assert from "node:assert/strict";
import { defaults, outputFilename, scheduleSlot, invoiceFolder, dropboxHash, digest, settingsInput, addedAfterCutoff } from "../src/lib/printscope/automationPolicy";
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
  for(const patch of [{times:[]},{times:["24:00"]},{weekdays:[7]},{email:"bad"},{settleMinutes:0},{timezone:"bad/zone"}]) assert.ok(!settingsInput.safeParse({...s,version:0,...patch}).success);
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
