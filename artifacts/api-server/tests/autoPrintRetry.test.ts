import assert from "node:assert/strict";
import test from "node:test";
import { startAutoPrintRun, anyRunActive } from "../src/lib/printQueue/autoPrint/engine";
import { h, reset } from "./autoPrintRetryHarness";
import { canReservePrint } from "../src/lib/printQueue/autoPrint/candidatePlanning";
import { retryablePreSubmission, runWorkorderAttempts, WorkorderSkip } from "../src/lib/printQueue/autoPrint/workorderRetry";

async function run(options: Record<string, unknown> = {}, dryRun = false) {
  reset(options);
  const logger: any = { info() {}, warn() {}, error() {} };
  const started = await startAutoPrintRun("manual", { dryRun }, logger);
  assert.equal(started.status, "started");
  for (let i = 0; i < 200 && anyRunActive(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(anyRunActive(), false, "offline run completed");
  assert.equal(h.runs[0].status, "success", h.runs[0].summary?.error);
  assert.equal(h.runs.length, 1, "no second batch");
  return h.jobs.find((job: any) => job.runId === h.runs[0].id);
}

test("actual engine: success on third attempt, one send, one final status, same batch PO", async () => {
  const job = await run({ renderFailures: 2 });
  assert.equal(job.status, "printed");
  assert.equal(h.renderCalls, 3);
  assert.equal(h.sendCalls, 1);
  assert.deepEqual(h.delays, [1000, 2000]);
  assert.equal(h.jobs.length, 1);
  assert.equal(job.snapshotMetadata.autoRetry.attemptCount, 3);
  assert.deepEqual(job.snapshotMetadata.autoRetry.attempts.map((a: any) => a.outcome), ["retrying", "retrying", "printed"]);
  assert.equal(h.runs[0].summary.counts.failed, 0);
  assert.equal(h.runs[0].summary.counts.printed, 1);
  assert.equal(h.statusJobs.length, 1);
  assert.equal(h.statusJobs[0][0].targetStatusId, "success");
  assert.equal(h.timeline.at(-1), "status-finalized");
  assert.equal(h.poBatches.length, 1);
  assert.equal(h.poBatches[0].runId, job.runId);
  assert.equal(h.poBatches[0].successfullyPrintedOrders.length, 1);
});

test("actual engine: exhausted renders count once, error status only at terminal failure", async () => {
  const job = await run({ renderFailures: 10 });
  assert.equal(job.status, "failed");
  assert.equal(h.renderCalls, 3);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.runs[0].summary.counts.failed, 1);
  assert.equal(h.statusJobs.length, 1);
  assert.equal(h.statusJobs[0][0].targetStatusId, "error");
  assert.equal(h.poBatches[0].successfullyPrintedOrders.length, 0);
  assert.equal(job.snapshotMetadata.autoRetry.attempts.at(-1).delayMs, 0);
});

test("actual engine: startup failures consume the same three-attempt budget and recover", async () => {
  const job = await run({ startupFailures: 2 });
  assert.equal(job.status, "printed");
  assert.equal(h.startupCalls, 3);
  assert.equal(h.renderCalls, 1);
  assert.deepEqual(job.snapshotMetadata.autoRetry.attempts.map((a: any) => a.phase), ["renderer_startup", "renderer_startup", "persistence"]);
  const exhausted = await run({ startupFailures: 9 });
  assert.equal(exhausted.status, "failed");
  assert.equal(h.startupCalls, 3);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs[0][0].targetStatusId, "error");
});

test("actual engine: pre-send claim survives backoff and is reused only within the same run", async () => {
  const job = await run({ afterClaimFailures: 2 });
  assert.equal(job.status, "printed");
  assert.equal(h.claimCalls, 1);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.sendCalls, 1);
  assert.equal(job.snapshotMetadata.autoRetry.attemptCount, 3);
  assert.ok(job.attemptKey);
  assert.equal(canReservePrint(h.jobs, null), false);
});

test("actual engine: exhausted known pre-send claim releases only at terminal outcome", async () => {
  const job = await run({ afterClaimFailures: 9 });
  assert.equal(job.status, "failed");
  assert.equal(job.attemptKey, null);
  assert.equal(h.claimCalls, 1);
  assert.equal(h.sendCalls, 0);
  assert.equal(job.snapshotMetadata.autoRetry.attemptCount, 3);
});

test("actual engine: timeout, server error, malformed acceptance and lost persistence never resend", async () => {
  for (const options of [
    { submissionError: new Error("PrintNode POST timed out") },
    { submissionError: new Error("PrintNode POST /printjobs failed (503)") },
    { submissionId: null },
    { uncertainPersistence: true },
  ]) {
    const job = await run(options);
    assert.equal(job.status, "submission_unknown");
    assert.equal(h.sendCalls, 1);
    assert.equal(h.renderCalls, 1);
    assert.deepEqual(h.delays, []);
    assert.ok(job.attemptKey);
    assert.equal(canReservePrint(h.jobs, null), false);
    assert.equal(h.statusJobs.length, 0);
    assert.equal(h.poBatches[0].successfullyPrintedOrders.length, 0);
  }
});

test("actual engine: permanent URL failures, moved source and concurrent claims do not retry", async () => {
  const permanent = await run({ permanentRenderError: "Workorder URL is not a Printavo page" });
  assert.equal(permanent.status, "failed");
  assert.equal(h.renderCalls, 1);
  assert.deepEqual(h.delays, []);
  const moved = await run({ moved: true });
  assert.equal(moved.status, "skipped");
  assert.equal(h.renderCalls, 1);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
  const conflict = await run({ conflict: true });
  assert.equal(conflict.status, "skipped");
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
});

test("actual engine: dry-run retries render without any print or status side effects", async () => {
  const job = await run({ renderFailures: 2 }, true);
  assert.equal(job.status, "dry_run");
  assert.equal(h.renderCalls, 3);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
  assert.equal(h.claimCalls, 0);
  assert.equal(h.poBatches.length, 0);
});

test("actual engine: old cached moved-out invoice is discovered and simulated without printing or status writes", async () => {
  const job = await run({ orders: [{
    printavoId: "order", visualId: 100, nickname: "Old outside newest 400",
    statusId: "stale-other-status", statusName: "Stale",
    data: { workorderUrl: "https://shop.printavo.com/work_orders/test" },
    detailSyncedAt: new Date("2020-01-01"), orderType: "invoice", customerDueAt: null,
  }] }, true);
  assert.equal(job.status, "dry_run");
  assert.equal(h.runs[0].summary.discoveryState, "complete");
  assert.equal(h.runs[0].summary.counts.candidates, 1);
  assert.match(h.runs[0].summary.discoveryMessage, /No invoice-age cutoff/);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
});

test("actual engine: discovery failure persists unknown freshness and never renders or writes status", async () => {
  reset({ discoveryError: new Error("Printavo unavailable") });
  const started = await startAutoPrintRun("manual", { dryRun: true },
    { info() {}, warn() {}, error() {} } as any);
  assert.equal(started.status, "started");
  for (let i = 0; i < 200 && anyRunActive(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(anyRunActive(), false);
  assert.equal(h.runs[0].status, "failed");
  assert.equal(h.runs[0].summary.discoveryState, "failed");
  assert.match(h.runs[0].summary.discoveryMessage, /count is unknown/);
  assert.equal(h.renderCalls, 0);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
});

test("actual engine: initial detail failures recover on third attempt with no extra delivery budget", async () => {
  const job = await run({ detailFailures: 2 });
  assert.equal(job.status, "printed");
  assert.equal(h.renderCalls, 1);
  assert.equal(h.sendCalls, 1);
  assert.deepEqual(h.delays, [1000, 2000]);
  assert.equal(job.snapshotMetadata.autoRetry.attemptCount, 3);
  assert.deepEqual(job.snapshotMetadata.autoRetry.attempts.map((a: any) => a.phase), ["live_detail", "live_detail", "persistence"]);
  const failed = await run({ detailFailures: 2, renderFailures: 1 });
  assert.equal(failed.status, "failed");
  assert.equal(h.renderCalls, 1, "no fourth workorder attempt after two read failures");
  assert.equal(h.sendCalls, 0);
  assert.equal(failed.snapshotMetadata.autoRetry.attemptCount, 3);
  assert.equal(h.statusJobs[0][0].targetStatusId, "error");
});

test("actual engine: detail, initial live status and renderer startup share one total budget", async () => {
  const job = await run({ detailFailures: 1, statusFailures: 1, startupFailures: 1 });
  assert.equal(job.status, "failed");
  assert.equal(h.startupCalls, 1);
  assert.equal(h.renderCalls, 0);
  assert.equal(h.sendCalls, 0);
  assert.deepEqual(h.delays, [1000, 2000]);
  assert.deepEqual(job.snapshotMetadata.autoRetry.attempts.map((a: any) => a.phase), ["live_detail", "verification", "renderer_startup"]);
  assert.equal(h.statusJobs.length, 1);
});

test("actual engine: exhausted detail reads terminally fail once and never render", async () => {
  const job = await run({ detailFailures: 9 });
  assert.equal(job.status, "failed");
  assert.equal(h.detailCalls, 3);
  assert.equal(h.renderCalls, 0);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.runs[0].summary.counts.failed, 1);
  assert.equal(h.runs[0].summary.counts.skipped, 0);
  assert.equal(h.statusJobs[0][0].targetStatusId, "error");
});

test("actual engine: genuine incomplete detail skips and permanent read/startup errors never retry", async () => {
  const missing = await run({ missingDetail: true });
  assert.equal(missing.status, "skipped");
  assert.equal(missing.reason, "live_detail_missing_or_incomplete");
  assert.equal(h.detailCalls, 1);
  assert.equal(h.renderCalls, 0);
  assert.equal(h.statusJobs.length, 0);
  const auth = await run({ permanentDetailError: Object.assign(new Error("Unauthorized"), { httpStatus: 401 }) });
  assert.equal(auth.status, "failed");
  assert.equal(h.detailCalls, 1);
  assert.deepEqual(h.delays, []);
  const startup = await run({ permanentStartupError: Object.assign(new Error("missing library"), { reason: "missing_library" }) });
  assert.equal(startup.status, "failed");
  assert.equal(h.startupCalls, 1);
  assert.deepEqual(h.delays, []);
});

test("actual engine: invoice 22787 remains a no-render/no-send intentional skip", async () => {
  const job = await run({ orders: [{ printavoId: "replacement", visualId: 22787, nickname: "Internal" }] });
  assert.equal(job.status, "skipped");
  assert.equal(job.reason, "internal_replacements_invoice_no_workorder");
  assert.equal(h.detailCalls, 0);
  assert.equal(h.startupCalls, 0);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
  assert.deepEqual(h.delays, []);
});

test("actual engine: previously printed unchanged work remains an intentional skip", async () => {
  const job = await run({ jobs: [{
    id: "prior-print", docType: "workorder", printavoOrderId: "order", visualId: "100",
    status: "printed", contentFingerprint: "prior-baseline", createdAt: new Date(0), printedAt: new Date(0),
  }] });
  assert.equal(job.status, "skipped");
  assert.equal(job.reason, "no_source_reentry_after_print");
  assert.equal(h.runs[0].summary.counts.alreadyPrinted, 1);
  assert.equal(h.renderCalls, 0);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
  assert.deepEqual(h.delays, []);
});

test("actual engine: detail failure cannot release another run's pending claim or finalize its status", async () => {
  const job = await run({ detailFailures: 9, jobs: [{
    id: "prior-pending", docType: "workorder", printavoOrderId: "order", visualId: "100",
    status: "pending", attemptKey: "durable-other-run-key", createdAt: new Date(0),
  }] });
  assert.equal(job.status, "failed");
  assert.equal(h.jobs[0].status, "pending");
  assert.equal(h.jobs[0].attemptKey, "durable-other-run-key");
  assert.equal(canReservePrint(h.jobs, null), false);
  assert.equal(h.sendCalls, 0);
  assert.equal(h.statusJobs.length, 0);
});

test("retry classifier: permanent startup/config failures and intentional skips stay terminal", async () => {
  for (const reason of ["executable_not_found", "missing_library", "permission_denied", "sandbox_failure"]) {
    assert.equal(retryablePreSubmission(Object.assign(new Error(reason), { reason }), "renderer_startup"), false);
  }
  for (const stage of ["configuration", "reservation", "submission", "persistence"] as const) {
    assert.equal(retryablePreSubmission(new Error("timeout"), stage), false);
  }
  assert.equal(retryablePreSubmission(new Error("net::ERR_CERT_AUTHORITY_INVALID"), "render"), false);
  let calls = 0;
  const result = await runWorkorderAttempts(async (context) => {
    calls++;
    context.stage("verification");
    throw new WorkorderSkip("intentional skip");
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.definitivePreSubmitFailure, false);
});