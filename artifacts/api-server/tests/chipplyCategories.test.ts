import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryMutation, commitReview, recommendation, staleLine, validSelection, validateSelections, type ReviewLine } from "../src/lib/chipply/categoryReview";

const categories = [{ id: "screen", name: "Screen Printing" }, { id: "emb", name: "Embroidery" }, { id: "heat", name: "HEAT APPLIED GRAPHICS" }, { id: "mixed", name: "Mixed Decoration" }];
const selection = { orderId: "order", lineItemId: "line" };
const live = { id: "line", position: 7, category: null, lineItemGroup: { order: { __typename: "Invoice", id: "order", nickname: "123456 Store", status: { id: "s", name: "MERCH PRINT: Complete" } } } };
const line: ReviewLine = { ...selection, currentCategoryId: null, currentCategoryName: null, recommendedCategoryId: "screen", recommendedCategoryName: "Screen Printing", statusName: "MERCH PRINT: Complete", statusId: "s", eligible: true, message: "Ready" };
const snapshot = { lines: [line], overwrite: false };
test("empty, duplicate, whitespace duplicate and over-cap selections are rejected", () => {
  assert.throws(() => validateSelections([]));
  assert.throws(() => validateSelections([selection, selection]));
  assert.throws(() => validateSelections([selection, { ...selection, lineItemId: " line " }]));
  assert.throws(() => validateSelections(Array.from({ length: 101 }, (_, i) => ({ orderId: "order", lineItemId: `${i}` }))));
  assert.doesNotThrow(() => validateSelections([selection]));
});

test("every method and stage normalizes whitespace/case, ignores status IDs", () => {
  for (const stage of ["NEW", "Art Approval", "In Production", "Complete", "Archived"]) {
    for (const [token, id] of [["PRINT", "screen"], ["EMB", "emb"], ["HEAT", "heat"], ["MIXED", "mixed"]]) {
      assert.equal(recommendation(`🟢 merch  \n ${token} : ${stage}`, categories).category?.id, id);
    }
  }
  for (const stage of ["Waiting 4 Blanks", "Ready 4 Production", "Ready 2 Pick/Pack", "Pick/Pack COMPLETE"]) {
    for (const [token, id] of [["PRINT", "screen"], ["EMB", "emb"], ["HEAT", "heat"], ["MIXED", "mixed"]]) {
      assert.equal(recommendation(`🟢 MERCH - ${token} ${stage}`, categories).category?.id, id);
    }
  }
  assert.equal(recommendation("🟢 MERCH - MIXED DECO Ready 4 Production", categories).category?.id, "mixed");
  assert.equal(recommendation("MERCH MIXED", []).category, null);
  assert.equal(recommendation("MERCH MIXED", [...categories, { id: "dupe-mixed", name: " MIXED  DECORATION " }]).category, null);
  assert.equal(recommendation("MERCH PRINT / MERCH EMB", categories).category, null);
  assert.equal(recommendation("Other", categories).category, null);
  assert.equal(recommendation("MERCH PRINT", []).category, null);
  assert.equal(recommendation("MERCH PRINT", [...categories, { id: "dupe", name: " SCREEN  PRINTING " }]).category, null);
});
test("builder only sends required live position and category", () => {
  assert.equal(categoryMutation("line", 7, "screen"), 'mutation { lineItemUpdate(id:"line", input:{position:7, category:{id:"screen"}}) { id category { id name } } }');
  assert.throws(() => categoryMutation("line", NaN, "screen"));
});
test("membership, recognition, current category, current status and mapping are revalidated", () => {
  assert.equal(validSelection(live, selection), true);
  assert.equal(validSelection(live, { ...selection, orderId: "other" }), false);
  assert.equal(validSelection({ ...live, lineItemGroup: { order: { ...live.lineItemGroup.order, __typename: "Quote" } } }, selection), false);
  assert.equal(staleLine(live, line, snapshot, categories), null);
  assert.match(staleLine({ ...live, category: categories[1]! }, line, snapshot, categories)!, /category changed/);
  assert.match(staleLine(live, { ...line, statusName: "old" }, snapshot, categories)!, /status changed/);
  assert.match(staleLine(live, line, snapshot, [])!, /recommendation changed/);
  assert.equal(staleLine(live, { ...line, recommendedCategoryId: "heat", recommendedCategoryName: "HEAT APPLIED GRAPHICS" }, { ...snapshot, targetCategoryId: "heat" }, categories), null);
});
function fixture(options: { unknown?: boolean; unauthorized?: boolean; auditFailure?: boolean; mirrorFailure?: boolean; recover?: "accepted" | "retry" | "different" | "read_error" | "status_changed" | "position_changed" | "incomplete_category"; denyRetry?: boolean } = {}) {
  let state = "preview";
  let held: string | null = null;
  let locked = false;
  let writes = 0;
  let refreshes = 0;
  let reads = 0;
  const io = {
    refresh: async () => { refreshes++; },
    client: {
      query: async (q: string) => {
        if(q.includes("account")) return { account: { categories: { nodes: categories, pageInfo: { hasNextPage: false } } } };
        reads++;
        if(writes && options.recover === "read_error") throw Error("read outage");
        const category = writes && (options.recover==="accepted" || (options.recover==="retry" && writes===2)) ? categories[0] :
          writes && options.recover==="different" ? categories[1] : writes && options.recover==="incomplete_category" ? {} : null;
        return { lineItem: { ...live, category,
          position:writes && options.recover==="position_changed" ? 8 : live.position,
          lineItemGroup:{order:{...live.lineItemGroup.order,status:writes && options.recover==="status_changed" ? {id:"new",name:"Progressed"} : live.lineItemGroup.order.status}} } };
      },
      mutate: async () => { writes++; if (options.unknown) throw new Error("timeout after acceptance"); return { lineItemUpdate: { id: "line", category: categories[0] } }; },
    },
    query: async (q: string) => {
      if (options.auditFailure && q.includes("INSERT INTO change_events")) throw new Error("local audit unavailable");
      if (options.mirrorFailure && q.includes("UPDATE pv_line_items")) throw new Error("local mirror unavailable");
      if (q.includes("RETURNING snapshot")) {
        if (state !== "preview" || options.unauthorized) return { rowCount: 0, rows: [] };
        state = "committing"; return { rowCount: 1, rows: [{ snapshot }] };
      }
      if (q.includes("pg_try_advisory_lock")) { const acquired = !locked; locked = true; return { rows: [{ acquired }] }; }
      if (q.includes("pg_advisory_unlock")) { locked = false; return { rows: [] }; }
      if (q.includes("SELECT state")) return { rows: held ? [{ state: held }] : [] };
      if (q.includes("RETURNING line_item_id")) {
        if(options.denyRetry || held!=="unknown")return {rowCount:0,rows:[]};
        held="in_flight";return {rowCount:1,rows:[{line_item_id:"line"}]};
      }
      if (q.includes("INSERT INTO chipply_category_claims")) held = "in_flight";
      if (q.includes("SET state='unknown'")) held = "unknown";
      if (q.includes("SET state='updated'")) held = "updated";
      return { rowCount: 1, rows: [] };
    },
  };
  (globalThis as unknown as { fixture: typeof io }).fixture = io;
  return { reads: () => reads, writes: () => writes, held: () => held, refreshes: () => refreshes, nextPreview: () => { state = "preview"; } };
}
test("duplicate simultaneous commit has only one write", async () => {
  const f = fixture();
  const results = await Promise.allSettled([commitReview("actor", "preview"), commitReview("actor", "preview")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.writes(), 1);
});
test("unknown outcome is durable and never resent by a fresh preview", async () => {
  const f = fixture({ unknown: true });
  assert.equal((await commitReview("actor", "preview")).results[0]?.outcome, "unknown");
  assert.equal(f.held(), "unknown");
  f.nextPreview();
  assert.equal((await commitReview("actor", "new-preview")).results[0]?.outcome, "conflict");
  assert.equal(f.writes(), 1);
});
test("unauthorized preview selection cannot commit", async () => {
  const f = fixture({ unauthorized: true });
  await assert.rejects(commitReview("other", "preview"), /belongs to another user/);
  assert.equal(f.writes(), 0);
});
test("confirmed upstream writes survive local audit/mirror failure and schedule read refresh", async () => {
  for (const options of [{ auditFailure: true }, { mirrorFailure: true }]) {
    const f = fixture(options);
    const logger = { warn: () => {} } as unknown as NonNullable<Parameters<typeof commitReview>[2]>;
    const result = await commitReview("actor", "preview", logger);
    assert.equal(result.results[0]?.outcome, "updated");
    assert.match(result.results[0]!.message, /refresh is pending/);
    assert.equal(f.held(), "updated");
    assert.equal(f.writes(), 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.refreshes(), 1);
  }
});
test("post-check confirms an accepted category without a second write",async()=>{
  const f=fixture({unknown:true,recover:"accepted"});
  const r=await commitReview("actor","preview",undefined,{postCheckMissing:true});
  assert.equal(r.results[0]?.outcome,"updated");assert.equal(f.writes(),1);assert.equal(f.held(),"updated");
  assert.match(r.results[0]!.message,/post-check/);
  assert.equal(f.reads(),2);
});
test("confirmed assignments do not enter the post-check or retry path",async()=>{
  const f=fixture();
  const r=await commitReview("actor","preview",undefined,{postCheckMissing:true});
  assert.equal(r.results[0]?.outcome,"updated");assert.equal(f.writes(),1);assert.equal(f.reads(),1);
});
test("blank post-check gets only one claimed retry and final verification",async()=>{
  const f=fixture({unknown:true,recover:"retry"});
  const r=await commitReview("actor","preview",undefined,{postCheckMissing:true});
  assert.equal(r.results[0]?.outcome,"updated");assert.equal(f.writes(),2);assert.equal(f.held(),"updated");
});
test("different category, changed status/position, read outage and denied retry never resend",async()=>{
  for(const options of [{recover:"different"},{recover:"read_error"},{recover:"status_changed"},{recover:"position_changed"},{recover:"incomplete_category"},{denyRetry:true}] as const){
    const f=fixture({unknown:true,...options});
    const r=await commitReview("actor","preview",undefined,{postCheckMissing:true});
    assert.notEqual(r.results[0]?.outcome,"updated");assert.equal(f.writes(),1);assert.equal(f.held(),"unknown");
  }
});
test("repeated uncertainty stops at two attempts and a new preview cannot restart retries",async()=>{
  const f=fixture({unknown:true});
  const r=await commitReview("actor","preview",undefined,{postCheckMissing:true});
  assert.equal(r.results[0]?.outcome,"unknown");assert.equal(f.writes(),2);
  f.nextPreview();
  assert.equal((await commitReview("actor","new",undefined,{postCheckMissing:true})).results[0]?.outcome,"conflict");
  assert.equal(f.writes(),2);
});