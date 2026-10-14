import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { replacementSlipSnapshot, renderReplacementSlipHtml } from "../src/lib/printQueue/autoPrint/replacementSlip";
import { runReplacementSlipBatch, type ReplacementSlipDependencies } from "../src/lib/printQueue/autoPrint/replacementSlipBatch";
import type { PoFileDto } from "../src/lib/purchasing/poFiles";
import { planMakeupAdditions, type MakeupObservation, type MakeupLine } from "../src/lib/printQueue/autoPrint/replacementAdditionPlan";

const line = (id: string, visualId = 22787) => ({
  printavoOrderId: visualId === 22787 ? "internal-id" : "customer-id",
  printavoLineItemId: id, visualId, styleNumber: "BP36", color: "Oatmeal Heather",
  vendorCatalogColor: null, description: "Full replacement instructions\nKeep this second line <verbatim>",
  brand: null, source: "vendor" as const, warehouseName: "New Jersey", warehouseCode: "NJ",
  sizes: [{ size: "Other", qty: 2, unitCost: 10, sku: null, inventoryKey: null, sizeIndex: null }],
});
export const fixture: PoFileDto = {
  id: "po-fixture", poNumber: "PO-TEST", vendorName: "sanmar", notes: null,
  lineItems: [line("replacement-a"), line("customer-b", 100)], totalQuantity: 4, totalCost: 40,
  pushedToPrintavoAt: null, submittedToVendorAt: "2026-10-06T01:30:00Z",
  vendorOrderNumber: "vendor-confirmed", locked: true, lockReason: "vendor", pushState: null,
  createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-06T01:30:00Z",
};
const orders = [{ printavoId: "internal-id", visualId: 22787, nickname: "Mint Make Ups 2026 (NEW)" }];

test("only exact internal snapshot lines and PO quantities; immutable copy", () => {
  const po = structuredClone(fixture);
  const snapshot = replacementSlipSnapshot(po, orders)!;
  assert.equal(snapshot.po.lineItems.length, 1);
  assert.equal(snapshot.po.lineItems[0].sizes[0].qty, 2);
  po.lineItems[0].sizes[0].qty = 99;
  assert.equal(snapshot.po.lineItems[0].sizes[0].qty, 2);
  assert.equal(replacementSlipSnapshot({ ...fixture, lineItems: [line("customer", 100)] }, orders), null);
});

test("metadata, Eastern order date, verbatim description and HTML escaping", () => {
  const html = renderReplacementSlipHtml(replacementSlipSnapshot(fixture, orders)!);
  for (const text of ["Invoice #22787", "Mint Make Ups 2026 (NEW)", "PO-TEST", "10/5/2026", "SanMar", "New Jersey", "NJ",
    "Full replacement instructions\nKeep this second line &lt;verbatim&gt;"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes("customer-b"));
  assert.ok(!html.includes("unitCost"));
});

test("multiple warehouses remain associated with each line; missing is explicit", () => {
  const po = structuredClone(fixture);
  po.lineItems = [line("a"), { ...line("b"), warehouseCode: "NV", warehouseName: "Nevada" },
    { ...line("c"), warehouseCode: undefined, warehouseName: undefined }];
  const html = renderReplacementSlipHtml(replacementSlipSnapshot(po, orders)!);
  for (const text of ["Multiple — shown by line", "New Jersey · NJ", "Nevada · NV", "Not recorded"]) assert.ok(html.includes(text));
});

test("missing identity, date, line id or invalid quantity fails closed", () => {
  for (const change of [
    (p: PoFileDto) => { p.lineItems[0].printavoOrderId = "wrong"; },
    (p: PoFileDto) => { p.lineItems[0].printavoLineItemId = null; },
    (p: PoFileDto) => { p.submittedToVendorAt = null; },
    (p: PoFileDto) => { p.lineItems[0].sizes[0].qty = -1; },
  ]) {
    const po = structuredClone(fixture); change(po);
    assert.throws(() => replacementSlipSnapshot(po, orders));
  }
});

function harness() {
  let status = "queued";
  let submissions = 0;
  let renders = 0;
  const deps: ReplacementSlipDependencies = {
    claim: async () => {
      if (status !== "queued") return [];
      status = "pending";
      return [{ id: "slip", snapshotMetadata: replacementSlipSnapshot(fixture, orders) }];
    },
    update: async (_id, patch) => { status = patch.status; },
    render: async () => { renders++; return Buffer.from("%PDF-offline-fixture"); },
    submit: async request => {
      assert.equal(status, "submission_unknown");
      assert.equal(request.copies, 1);
      assert.match(request.title, /PO-TEST/);
      submissions++; return 123;
    },
  };
  const input = { runId: "run-1", printerId: "10", printerName: "Shop", dryRun: false, production: true };
  return { deps, input, stats: () => ({ status, submissions, renders }) };
}

test("replacement-only batch prints once across runs and concurrent consumers", async () => {
  const h = harness();
  const results = await Promise.all([runReplacementSlipBatch(h.input, h.deps), runReplacementSlipBatch({ ...h.input, runId: "other" }, h.deps)]);
  assert.equal(results.reduce((n, r) => n + r.printed, 0), 1);
  await runReplacementSlipBatch({ ...h.input, runId: "later" }, h.deps);
  assert.deepEqual(h.stats(), { status: "printed", submissions: 1, renders: 1 });
});

test("dry run and development do not claim, render or print; invalid printer fails before claim", async () => {
  for (const flags of [{ dryRun: true }, { production: false }, { printerId: null }]) {
    const h = harness();
    await runReplacementSlipBatch({ ...h.input, ...flags }, h.deps);
    assert.deepEqual(h.stats(), { status: "queued", submissions: 0, renders: 0 });
  }
  const h = harness();
  await assert.rejects(runReplacementSlipBatch({ ...h.input, printerId: "0" }, h.deps));
  assert.equal(h.stats().status, "queued");
});

test("ambiguous printer acceptance stays locked across later runs", async () => {
  const h = harness();
  let attempts = 0;
  h.deps.submit = async () => { attempts++; throw new Error("timeout after send"); };
  assert.equal((await runReplacementSlipBatch(h.input, h.deps)).failed, 1);
  await runReplacementSlipBatch({ ...h.input, runId: "later" }, h.deps);
  assert.equal(h.stats().status, "submission_unknown");
  assert.equal(attempts, 1);
});

test("renderer and pre-submit audit failures cannot send a job", async () => {
  for (const boundary of ["render", "update"] as const) {
    const h = harness();
    h.deps[boundary] = async () => { throw new Error("offline failure"); };
    assert.equal((await runReplacementSlipBatch(h.input, h.deps)).failed, 1);
    assert.equal(h.stats().submissions, 0);
    await runReplacementSlipBatch(h.input, h.deps);
    assert.equal(h.stats().submissions, 0);
  }
});

test("accepted job whose audit fails is not resubmitted", async () => {
  const h = harness();
  const update = h.deps.update;
  h.deps.update = async (id, patch) => {
    if (patch.status === "printed") throw new Error("DB unavailable");
    await update(id, patch);
  };
  assert.equal((await runReplacementSlipBatch(h.input, h.deps)).failed, 1);
  await runReplacementSlipBatch({ ...h.input, runId: "later" }, h.deps);
  assert.equal(h.stats().submissions, 1);
  assert.equal(h.stats().status, "submission_unknown");
});

test("production additions replace the submission trigger without changing vendor submissions", () => {
  const source = (name: string) => readFileSync(new URL(`../src/lib/${name}`, import.meta.url), "utf8");
  // Runtime integration is intentionally checked without ordering garments.
  const po = source("purchasing/poFiles.ts");
  assert.match(po, /if \(row\.submittedToVendorAt\) return/);
  assert.doesNotMatch(po, /enqueueReplacementSlip/);
  for (const file of ["vendorSubmit.ts", "vendorTracking.ts"]) assert.match(source(`purchasing/${file}`), /await submitPoToVendor\(poFileId, vendorOrderNumber\)/);
  assert.match(source("purchasing/vendorSubmit.ts"), /if \(mode === "live"\) await lockPoAsSubmitted/);
  const queue = source("printQueue/autoPrint/replacementSlipQueue.ts");
  assert.match(queue, /eq\(pqPrintJobsTable.status, "queued"\)/);
  const discovery = source("printQueue/autoPrint/replacementAdditionDiscovery.ts");
  assert.match(discovery, /process\.env\.NODE_ENV !== "production"/);
  assert.match(discovery, /pg_advisory_xact_lock/);
  assert.match(discovery, /await db.transaction/);
  assert.match(discovery, /onConflictDoNothing/);
  const engine = source("printQueue/autoPrint/engine.ts");
  assert.match(engine, /config.enabled && !dryRun && process.env.NODE_ENV === "production"/);
  assert.match(engine, /await discoverReplacementAdditions\(runId\)/);
});

const observedLine = (id: string, groupId = "existing-group"): MakeupLine => ({
  id, groupId, itemNumber: "BP36", color: "Oatmeal Heather",
  description: "Full replacement instructions\nKeep this second line <verbatim>",
  sizes: [{ size: "Other", count: 2 }],
});
const observation = (lines: MakeupLine[], observedAt = "2026-10-12T12:00:00Z"): MakeupObservation => ({
  orderId: "internal-id", nickname: "Makeups", observedAt, lines,
});
const baseline = planMakeupAdditions(observation([observedLine("old")]), null).baseline;
test("Makeups accepts unused null size cells but rejects invalid nonblank quantities", () => {
  const line = { ...observedLine("new-medium"), itemNumber: "BC3513", color: "Solid Black Triblend",
    sizes: [{ size: "size_s", count: null }, { size: "size_m", count: 2 }, { size: "size_l", count: null }] };
  const plan = planMakeupAdditions(observation([line], "2026-10-12T12:05:00Z"), baseline);
  assert.equal(plan.slips.length, 1);
  assert.equal(plan.slips[0].po.lineItems[0].sizes.reduce((n, s) => n + s.qty, 0), 2);
  assert.ok(plan.baseline.seenLineIds.includes("new-medium"));
  for (const count of [-1, 1.5, NaN, "2", undefined]) {
    assert.throws(() => planMakeupAdditions(observation([{ ...line,
      sizes: [{ size: "size_m", count: count as number }] }], "2026-10-12T12:05:00Z"), baseline),
    /BC3513 Solid Black Triblend.*baseline unchanged/);
  }
  assert.ok(!baseline.seenLineIds.includes("new-medium"));
});

test("first complete observation baselines history; new lines in existing and new groups print", () => {
  assert.equal(planMakeupAdditions(observation([observedLine("old")]), null).slips.length, 0);
  const plan = planMakeupAdditions(observation([observedLine("old"), observedLine("new"), observedLine("new-group-line", "new-group")], "2026-10-12T12:05:00Z"), baseline);
  assert.deepEqual(plan.slips[0].po.lineItems.map(l => l.printavoLineItemId), ["new", "new-group-line"]);
  assert.equal(plan.slips[0].po.poNumber, "PO not assigned");
  const html = renderReplacementSlipHtml(plan.slips[0]);
  assert.match(html, /PO not assigned/);
  assert.match(html, /Not recorded/);
  assert.doesNotMatch(html, /Invalid Date/);
  assert.match(html, /Keep this second line &lt;verbatim&gt;/);
});

test("each assigned Printavo PO gets its own slip and vendor, without inventing order dates", () => {
  const a = { ...observedLine("a"), poLineItem: { purchaseOrder: { id: "pv-a", visualPoId: "Custom-123", vendor: { company: "Outside Vendor" } } } };
  const b = { ...observedLine("b"), poLineItem: { purchaseOrder: { id: "pv-b", visualPoId: "Custom-456" } } };
  const plan = planMakeupAdditions(observation([a, b], "2026-10-12T12:05:00Z"), baseline);
  assert.equal(plan.slips.length, 2);
  assert.equal(plan.slips[0].po.poNumber, "Custom-123");
  assert.equal(plan.slips[0].po.vendorName, "Outside Vendor");
  assert.equal(plan.slips[0].po.submittedToVendorAt, null);
});

test("later PO assignment, Hub submission, edits, group moves, removal/reappearance and restart do not reprint", () => {
  const first = planMakeupAdditions(observation([observedLine("a")], "2026-10-12T12:05:00Z"), baseline);
  const edited = { ...observedLine("a", "moved-group"), description: "Edited", sizes: [{ size: "Other", count: 20 }],
    poLineItem: { purchaseOrder: { id: "pv-po", visualPoId: "PO-TEST" } } };
  const restarted = JSON.parse(JSON.stringify(first.baseline));
  const second = planMakeupAdditions(observation([edited], "2026-10-12T12:10:00Z"), restarted,
    [{ poNumber: "PO-TEST", vendorName: "sanmar", submittedToVendorAt: fixture.submittedToVendorAt!, line: line("a") }]);
  assert.equal(second.slips.length, 0);
  const removed = planMakeupAdditions(observation([], "2026-10-12T12:15:00Z"), second.baseline);
  assert.equal(planMakeupAdditions(observation([edited], "2026-10-12T12:20:00Z"), removed.baseline).slips.length, 0);
  assert.equal(planMakeupAdditions(observation([observedLine("late")]), first.baseline).slips.length, 0);
});

test("exact Hub references enrich metadata but new-line quantities stay invoice quantities", () => {
  const plan = planMakeupAdditions(observation([{ ...observedLine("a"), sizes: [{ size: "XL", count: 7 }] }], "2026-10-12T12:05:00Z"), baseline,
    [{ poNumber: "PO-TEST", vendorName: "sanmar", submittedToVendorAt: fixture.submittedToVendorAt!, line: line("a") }]);
  assert.equal(plan.slips[0].po.poNumber, "PO-TEST");
  assert.equal(plan.slips[0].po.lineItems[0].sizes[0].qty, 7);
  assert.equal(plan.slips[0].po.lineItems[0].warehouseName, "New Jersey");
  assert.throws(() => planMakeupAdditions({ ...observation([]), orderId: "different" }, baseline), /identity changed/);
});

test("new-line slips use existing single-submission and uncertainty safeguards", async () => {
  const snapshot = planMakeupAdditions(observation([observedLine("a")], "2026-10-12T12:05:00Z"), baseline).slips[0];
  let claimed = false;
  let submissions = 0;
  let status = "queued";
  const deps: ReplacementSlipDependencies = {
    claim: async () => { if (claimed) return []; claimed = true; return [{ id: "addition", snapshotMetadata: snapshot }]; },
    update: async (_id, patch) => { status = patch.status; },
    render: async html => { assert.match(html, /PO not assigned/); return Buffer.from("offline pdf"); },
    submit: async () => { submissions++; throw new Error("uncertain network response"); },
  };
  const input = { runId: "run", printerId: "1", printerName: "offline", dryRun: false, production: true };
  await runReplacementSlipBatch(input, deps);
  assert.equal(status, "submission_unknown");
  await runReplacementSlipBatch(input, deps);
  assert.equal(submissions, 1);
});
