import type { AutoPrintNotification, AutoPrintRun, AutoPrintRetryJob } from "@workspace/api-client-react";

const date = "2026-10-10T12:00:00Z";
export const run: AutoPrintRun = {
  id: "run-recent", trigger: "scheduled", dryRun: false, status: "failed",
  startedAt: date, finishedAt: date, createdAt: date, error: "Mock run failure",
  advanceJobId: null, advanceSkipped: null, discoveryState: "complete",
  counts: { candidates: 1, alreadyPrinted: 0, detailPending: 0, deferred: 0, printed: 0, failed: 1, dryRun: 0 },
};
export const jobs: AutoPrintRetryJob[] = ["job-first", "job-unknown", "job-other"].map((id, i) => ({
  id, runId: run.id, printavoOrderId: `mock-order-${i}`, visualId: `9000${i}`,
  status: i === 1 ? "submission_unknown" : "retry_pending",
  retryManaged: true, retryPhase: "initial", retryCount: 1,
  nextRetryAt: i === 1 ? null : date, errorMessage: "Mock failure",
  sourceStatusId: "mock-status", sourceStatusName: "Ordered", printnodeJobId: null, attempts: [],
}));
export const notifications: AutoPrintNotification[] = Array.from({ length: 35 }, (_, i) => {
  const kind = (["failure", "manual_review", "acceptance_unknown", "run_failure"] as const)[i % 4];
  const jobId = kind === "run_failure" ? null : kind === "acceptance_unknown" ? "job-unknown" : "job-first";
  const runId = i === 7 ? "run-older" : run.id;
  return {
    id: `alert-${i + 1}`, kind, title: `${kind.replaceAll("_", " ")} fixture ${i + 1}`,
    reason: kind === "failure" ? "First attempt failed; automatic retry scheduled." : "Escalation requires administrator review.",
    documentType: "workorder", visualId: jobId === "job-unknown" ? "90001" : "90000",
    poNumber: null, runId, jobId, occurredAt: date, retryState: "retry_pending",
    nextAttemptAt: date, currentState: kind === "acceptance_unknown" ? "submission_unknown" : "held",
    currentNextAttemptAt: null, read: false,
    href: jobId ? `/auto-print?job=${jobId}#autoprint-retry-review` : `/auto-print?run=${runId}#autoprint-run-history`,
  };
});
