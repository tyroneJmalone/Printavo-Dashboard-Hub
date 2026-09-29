import assert from "node:assert/strict";
import test from "node:test";
import type { PoFileDto } from "../src/lib/purchasing/poFiles";
import {
  runHubPoBatch,
  type HubPoBatchDependencies,
  type HubPoBatchInput,
  type HubPoJobUpdate,
  type HubPoReservation,
} from "../src/lib/printQueue/autoPrint/hubPoBatch";

function po(id: string, orders: string[]): PoFileDto {
  return {
    id, poNumber: `PO-${id}`, vendorName: "manual", notes: null,
    totalQuantity: orders.length, totalCost: orders.length,
    lineItems: orders.map((order) => ({
      printavoOrderId: order, printavoLineItemId: null, visualId: 100,
      styleNumber: "saved-style", color: null, vendorCatalogColor: null,
      description: null, brand: null, source: "manual",
      sizes: [{ size: "M", qty: 1, unitCost: 1, sku: null, inventoryKey: null, sizeIndex: null }],
    })),
    pushedToPrintavoAt: null, submittedToVendorAt: null, vendorOrderNumber: null,
    locked: false, lockReason: null, pushState: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function harness(pos: PoFileDto[]) {
  const jobs = new Map<string, Omit<HubPoReservation, "status"> & {
    status: "pending" | HubPoJobUpdate["status"];
  }>();
  const submissions: Parameters<HubPoBatchDependencies["submit"]>[0][] = [];
  const html: string[] = [];
  const deps: HubPoBatchDependencies = {
    loadRelevantPos: async () => pos,
    reserve: async (job) => {
      const key = `${job.runId}/${job.hubPoId}`;
      if (jobs.has(key)) return null;
      jobs.set(key, { ...job });
      return key;
    },
    updateJob: async (id, update) => {
      Object.assign(jobs.get(id)!, update);
    },
    submit: async (request) => {
      assert.equal([...jobs.values()].at(-1)?.status, "submission_unknown");
      submissions.push(request);
      return 123;
    },
  };
  const input: HubPoBatchInput = {
    runId: "run", successfullyPrintedOrders: [{ orderId: "a", visualId: 100 }, { orderId: "b", visualId: 101 }],
    printerId: "10", printerName: "Shop", dryRun: false,
    renderPdf: async (content) => { html.push(content); return Buffer.from("%PDF-offline-fixture"); },
  };
  return { deps, input, jobs, submissions, html };
}

test("shared PO dedupes across successful workorders and always submits one copy", async () => {
  const shared = po("shared", ["a", "b"]);
  const h = harness([shared, shared, po("unrelated", ["other"]), po("failed-only", ["failed"])]);
  const result = await runHubPoBatch(h.input, h.deps);
  assert.equal(result.printed, 1);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].copies, 1);
  const job = h.jobs.get("run/shared")!;
  assert.equal(job.docType, "hub_po");
  assert.equal(job.status, "printed");
  assert.equal(job.snapshotMetadata.matchedOrders.length, 2);
  assert.equal(job.snapshotMetadata.po.poNumber, "PO-shared");
  assert.match(job.snapshotMetadata.sha256, /^[a-f0-9]{64}$/);
});

test("only failed workorders and no successful workorders produce no PO submission", async () => {
  const h = harness([po("failed-only", ["failed"])]);
  assert.equal((await runHubPoBatch(h.input, h.deps)).printed, 0);
  h.input.successfullyPrintedOrders = [];
  h.deps.loadRelevantPos = async () => { throw new Error("must not query"); };
  assert.equal((await runHubPoBatch(h.input, h.deps)).failed, 0);
  assert.equal(h.submissions.length, 0);
});

test("a visual id match without a verified original order id cannot print a PO", async () => {
  const h = harness([po("converted", ["old"])]);
  assert.equal((await runHubPoBatch(h.input, h.deps)).printed, 0);
  h.input.successfullyPrintedOrders = [{ orderId: "a", visualId: 100, verifiedSnapshotOrderIds: ["old"] }];
  assert.equal((await runHubPoBatch(h.input, h.deps)).printed, 1);
});

test("timeout holds submission_unknown and restart does not render or submit again", async () => {
  const h = harness([po("one", ["a"])]);
  let attempts = 0;
  h.deps.submit = async () => { attempts++; throw new Error("network timeout"); };
  const first = await runHubPoBatch(h.input, h.deps);
  assert.equal(first.unknown, 1);
  assert.equal(first.failed, 0);
  assert.equal(h.jobs.get("run/one")!.status, "submission_unknown");
  assert.match(first.warnings[0], /automatic retry blocked/);
  assert.equal((await runHubPoBatch(h.input, h.deps)).skipped, 1);
  assert.equal(attempts, 1);
  assert.equal(h.html.length, 1);
});

test("existing pending reservation blocks restart and concurrent invocations", async () => {
  const h = harness([po("one", ["a"])]);
  const results = await Promise.all([runHubPoBatch(h.input, h.deps), runHubPoBatch(h.input, h.deps)]);
  assert.equal(results.reduce((n, r) => n + r.printed, 0), 1);
  assert.equal(results.reduce((n, r) => n + r.skipped, 0), 1);
  Object.assign(h.jobs.get("run/one")!, { status: "pending" });
  assert.equal((await runHubPoBatch(h.input, h.deps)).skipped, 1);
  assert.equal(h.submissions.length, 1);
});

test("frozen snapshot renders original content even when saved PO is edited after reservation", async () => {
  const original = po("one", ["a"]);
  const h = harness([original]);
  const reserve = h.deps.reserve;
  h.deps.reserve = async (job) => {
    assert.ok(Object.isFrozen(job.snapshotMetadata.po.lineItems[0]));
    original.lineItems[0].styleNumber = "changed-after-reservation";
    original.poNumber = "changed";
    return reserve(job);
  };
  assert.equal((await runHubPoBatch(h.input, h.deps)).printed, 1);
  assert.match(h.html[0], /saved-style/);
  assert.doesNotMatch(h.html[0], /changed-after-reservation/);
  assert.equal(h.jobs.get("run/one")!.hubPoNumber, "PO-one");
});

test("render failure is failed, not unknown, and cannot resubmit on same-run restart", async () => {
  const h = harness([po("one", ["a"])]);
  h.input.renderPdf = async () => { throw new Error("renderer failed"); };
  assert.equal((await runHubPoBatch(h.input, h.deps)).failed, 1);
  assert.equal(h.jobs.get("run/one")!.status, "failed");
  assert.equal(h.submissions.length, 0);
  assert.equal((await runHubPoBatch(h.input, h.deps)).skipped, 1);
});

test("failed reservation or uncertainty marker fails closed before PrintNode", async () => {
  for (const boundary of ["reserve", "updateJob"] as const) {
    const h = harness([po("one", ["a"])]);
    h.deps[boundary] = async () => { throw new Error("database unavailable"); };
    assert.equal((await runHubPoBatch(h.input, h.deps)).failed, 1);
    assert.equal(h.submissions.length, 0);
  }
});

test("acceptance audit failure remains unknown, never automatically retries", async () => {
  const h = harness([po("one", ["a"])]);
  const update = h.deps.updateJob;
  h.deps.updateJob = async (id, patch) => {
    if (patch.status === "printed") throw new Error("database unavailable");
    await update(id, patch);
  };
  assert.equal((await runHubPoBatch(h.input, h.deps)).unknown, 1);
  assert.equal((await runHubPoBatch(h.input, h.deps)).skipped, 1);
  assert.equal(h.submissions.length, 1);
});

test("dry run does not reserve, render, or submit", async () => {
  const h = harness([po("one", ["a"])]);
  h.input.dryRun = true;
  assert.equal((await runHubPoBatch(h.input, h.deps)).skipped, 1);
  assert.equal(h.jobs.size, 0);
  assert.equal(h.html.length, 0);
  assert.equal(h.submissions.length, 0);
});