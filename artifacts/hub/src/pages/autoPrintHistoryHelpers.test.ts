import test from "node:test";
import { retryHistory } from "./autoPrintHistoryHelpers.ts";
import assert from "node:assert/strict";
import { hasUnrecordedSkips, isPurchaseOrder, jobReasonLabel, jobStatusLabel, matchesHistoryFilter, needsReconciliation, nextHistoryOffset } from "./autoPrintHistoryHelpers.ts";

const invoice = { status: "skipped", docType: "workorder", isReprint: false };

test("retry history handles legacy and malformed metadata and preserves attempt details", () => {
  for (const metadata of [null, {}, { autoRetry: null }, { autoRetry: { attempts: [] } }]) {
    assert.equal(retryHistory(metadata), null);
  }
  const attempts = [{ attempt: 1, phase: "render", outcome: "retrying", error: "timeout", delayMs: 1000 },
    { attempt: 2, phase: "persistence", outcome: "printed", error: null, delayMs: 0 }];
  assert.deepEqual(retryHistory({ autoRetry: { attemptCount: 2, maxAttempts: 3, attempts } }), { count: 2, max: 3, attempts });
});

test("skipped invoice filter excludes separate PO copies", () => {
  assert.equal(matchesHistoryFilter(invoice, "skipped"), true);
  for (const po of [{ ...invoice, hubPoNumber: "PO-123" }, { ...invoice, hubPoId: "po-id" }, { ...invoice, docType: "hub_po" }]) {
    assert.equal(isPurchaseOrder(po), true);
    assert.equal(matchesHistoryFilter(po, "skipped"), false);
    assert.equal(matchesHistoryFilter(po, "purchase_orders"), true);
  }
});

test("reprints and all-documents filters do not imply submission success", () => {
  assert.equal(matchesHistoryFilter({ ...invoice, isReprint: true, status: "failed" }, "reprints"), true);
  assert.equal(matchesHistoryFilter(invoice, "reprints"), false);
  assert.equal(matchesHistoryFilter(invoice, "all"), true);
});

test("pending, unknown and reserved submissions require reconciliation", () => {
  for (const job of [
    { ...invoice, status: "pending" }, { ...invoice, status: "submission_unknown" },
    { ...invoice, reason: "prior_submission_unresolved" },
    { ...invoice, reason: "concurrent_or_previously_reserved_attempt" },
  ]) {
    assert.equal(needsReconciliation(job), true);
    assert.equal(matchesHistoryFilter(job, "needs_review"), true);
  }
  assert.equal(needsReconciliation({ ...invoice, status: "printed" }), false);
  assert.equal(matchesHistoryFilter({ ...invoice, reason: "prior_print_baseline_missing" }, "needs_review"), true);
  assert.equal(matchesHistoryFilter({ ...invoice, status: "failed" }, "needs_review"), true);
});

test("submission labels do not claim confirmed paper output", () => {
  assert.equal(jobStatusLabel("printed"), "Sent to printer");
  assert.equal(jobStatusLabel("dry_run"), "Simulated");
  assert.match(jobStatusLabel("submission_unknown"), /unknown/);
  assert.match(jobStatusLabel("pending"), /review/);
  assert.equal(jobStatusLabel("future_status"), "future_status");
});

test("reasons explain reentry, unchanged lines and missing legacy baseline", () => {
  assert.match(jobReasonLabel("prior_print_baseline_missing"), /manual review/);
  assert.match(jobReasonLabel("no_source_reentry_after_print"), /No observed return/);
  assert.match(jobReasonLabel("line_items_unchanged"), /unchanged/);
  assert.equal(jobReasonLabel("new_backend_reason"), "new_backend_reason");
  assert.equal(jobReasonLabel(null), "No reason recorded.");
});

test("legacy missing skips are not presented as no skipped invoices", () => {
  assert.equal(hasUnrecordedSkips({ alreadyPrinted: 4 }, []), true);
  assert.equal(hasUnrecordedSkips({ alreadyPrinted: 4, skipped: 0 }, []), true);
  assert.equal(hasUnrecordedSkips({ alreadyPrinted: 4, skipped: 4 }, []), false);
  assert.equal(hasUnrecordedSkips({ alreadyPrinted: 4 }, [invoice]), false);
  assert.equal(hasUnrecordedSkips({ alreadyPrinted: 0 }, []), false);
});

test("full pages remain loadable beyond 200 and terminate only on short page", () => {
  assert.equal(nextHistoryOffset(200, 1), 200);
  assert.equal(nextHistoryOffset(200, 2), 400);
  assert.equal(nextHistoryOffset(199, 3), undefined);
  assert.equal(nextHistoryOffset(0, 3), undefined);
});