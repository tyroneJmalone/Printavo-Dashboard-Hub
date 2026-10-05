import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { replacementSlipSnapshot, renderReplacementSlipHtml } from "../src/lib/printQueue/autoPrint/replacementSlip";
import { runReplacementSlipBatch, type ReplacementSlipDependencies } from "../src/lib/printQueue/autoPrint/replacementSlipBatch";
import type { PoFileDto } from "../src/lib/purchasing/poFiles";

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

test("production hooks use the one transactional submission path; no historical scanner", () => {
  const source = (name: string) => readFileSync(new URL(`../src/lib/${name}`, import.meta.url), "utf8");
  // Runtime integration is intentionally checked without ordering garments.
  const po = source("purchasing/poFiles.ts");
  assert.match(po, /if \(row\.submittedToVendorAt\) return/);
  assert.match(po, /await enqueueReplacementSlip\(tx, toDto\(rows\[0\]\)\)/);
  for (const file of ["vendorSubmit.ts", "vendorTracking.ts"]) assert.match(source(`purchasing/${file}`), /await submitPoToVendor\(poFileId, vendorOrderNumber\)/);
  assert.match(source("purchasing/vendorSubmit.ts"), /if \(mode === "live"\) await lockPoAsSubmitted/);
  const queue = source("printQueue/autoPrint/replacementSlipQueue.ts");
  assert.match(queue, /process\.env\.NODE_ENV !== "production"/);
  assert.match(queue, /attemptKey: `replacement-slip:\$\{po.id\}:22787`/);
  assert.match(queue, /eq\(pqPrintJobsTable.status, "queued"\)/);
});
