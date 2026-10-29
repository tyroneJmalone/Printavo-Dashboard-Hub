import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ScanRunHistory } from "../src/pages/printscope/ScanRunHistory";

const render = (detail:unknown,state="completed") => renderToStaticMarkup(
  <ScanRunHistory runs={[{id:"run",state,detail,createdAt:"2026-10-29T01:37:00Z"}]} />
);
test("historical count-only scans do not invent reasons",()=>{
  const html=render({held:6,invoices:0,queued:0,unchanged:0,errors:[]});
  assert.match(html,/Held \/ Skipped \(6\)/);
  assert.match(html,/older scan saved only a total/);
  assert.match(html,/Failed \(0\)/);
});
test("new holds and failures expose invoice, file, escaped reason and omission count",()=>{
  const html=render({held:501,heldDetails:[{orderId:"21512127",visualId:"20625",reason:"Prep task completed"}],heldDetailsOmitted:500,
    failedDetails:[{orderId:"21512127",visualId:"20625",filename:"Front OUTPUT.ai",reason:"Download failed <unsafe>"}]},"partial");
  assert.match(html,/https:\/\/www.printavo.com\/invoices\/21512127/);
  assert.match(html,/Invoice #20625/);
  assert.match(html,/Prep task completed/);
  assert.match(html,/Failed \(1\)/);
  assert.match(html,/Front OUTPUT.ai/);
  assert.match(html,/Download failed &lt;unsafe&gt;/);
  assert.match(html,/500 additional entries omitted/);
});
test("legacy fatal failures stay visible and empty new scans are explicit",()=>{
  assert.match(render({error:"Printavo limit",errors:[]},"failed"),/Printavo limit/);
  assert.match(render({held:0,heldDetails:[],failedDetails:[]}),/None recorded/);
  assert.doesNotMatch(render({held:0,heldDetails:[],failedDetails:[]}),/older scan/);
});
