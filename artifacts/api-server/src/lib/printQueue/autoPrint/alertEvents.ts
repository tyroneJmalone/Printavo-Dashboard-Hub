import { abandonedRun } from "./runHeartbeat";

/** Pure read-only interpretation of durable print audit records.
 * No printer, vendor, Printavo, retry, or status-write dependencies are allowed here.
 */
export interface AlertJob {
  id: string; runId: string; docType: string; visualId: string | null;
  hubPoNumber: string | null; status: string; errorMessage: string | null;
  retryPhase: string | null; nextRetryAt: Date | null; leaseUntil: Date | null;
  createdAt: Date; printnodeJobId: string | null;
  printavoOrderId?: string;
}
export interface AlertAttempt {
  outcome: string; error: string | null; phase: string;
  startedAt: Date; finishedAt: Date | null;
}
export interface AlertRun {
  id: string; dryRun: boolean; status: string; summary: unknown;
  startedAt: Date; finishedAt: Date | null; updatedAt: Date;
}
export interface AlertPayload {
  title: string; reason: string; documentType: string; visualId: string | null;
  poNumber: string | null; occurredAt: string; retryState: string;
  nextAttemptAt: string | null; href: string;
}
export interface AlertEvent {
  eventKey: string; kind: "failure" | "manual_review" | "acceptance_unknown" | "run_failure";
  jobId: string | null; runId: string | null; payload: AlertPayload;
}
const failedOutcomes = new Set(["retry_pending", "failed", "held", "exhausted", "submission_unknown", "printed"]);
const manualStates = new Set(["failed", "held", "exhausted"]);
const docNames: Record<string, string> = {
  workorder: "Workorder", hub_po: "PO copy", replacement_slip: "Replacement slip",
};

export function jobAlertEvents(
  job: AlertJob, attempts: AlertAttempt[], run: AlertRun | undefined, since: Date, now = new Date(),
): AlertEvent[] {
  if (run?.dryRun || job.status === "dry_run") return [];
  const recent = attempts.filter(a => a.finishedAt && a.finishedAt >= since)
    .sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime());
  const failures = recent.filter(a => a.error && failedOutcomes.has(a.outcome)
    && a.phase !== "operator" && a.phase !== "reconciliation");
  const newJob = job.createdAt >= since || !!(run && run.startedAt >= since);
  if (!newJob && !attempts.some(a => a.startedAt >= since || (a.finishedAt && a.finishedAt >= since))) return [];
  // PO/slip "unknown" is a reservation BEFORE the POST; it is not yet a failure.
  // A finished run or an abandoned reservation is evidence worth alerting on.
  const reservationAge = now.getTime() - Math.max(job.createdAt.getTime(), run?.startedAt.getTime() ?? 0);
  const isReservationMarker = job.errorMessage === "Submission reserved; acceptance not yet confirmed. Do not automatically retry."
    || job.errorMessage === "Printer acceptance not yet confirmed. Do not automatically resend.";
  const reservationActive = job.docType !== "workorder" && job.status === "submission_unknown"
    && isReservationMarker && run?.status === "running" && reservationAge < 10 * 60_000;
  if (reservationActive) return [];
  const expiredLease = job.status === "pending" && job.leaseUntil !== null && job.leaseUntil <= now;
  const strandedDocument = job.docType !== "workorder" && job.status === "pending"
    && (run?.status === "failed" || reservationAge > 10 * 60_000);
  const uncertain = job.status === "submission_unknown" || (expiredLease && job.retryPhase === "submitting");
  const currentProblem = !!job.errorMessage || uncertain || expiredLease || strandedDocument;
  if (!failures.length && !currentProblem) return [];
  if (job.status === "skipped" || job.status === "cancelled") {
    // A cancellation is not a new failure; historical failed attempts still notify.
    if (!failures.length) return [];
  }
  const first = failures[0];
  const reason = first?.error ?? job.errorMessage
    ?? (uncertain ? "Submission worker stopped after the send fence. Printer acceptance is unknown."
      : "Print worker stopped before the outcome was recorded; administrator review is required.");
  const firstState = first?.outcome ?? (uncertain ? "submission_unknown" : expiredLease || strandedDocument ? "held" : job.status);
  const documentType = docNames[job.docType] ?? job.docType;
  const visualId = job.visualId ?? (job.docType === "workorder" ? job.printavoOrderId ?? null : null);
  const subject = `${documentType}${visualId ? ` #${visualId}` : ""}${job.hubPoNumber ? ` · PO ${job.hubPoNumber}` : ""}`;
  const href = `/auto-print?run=${encodeURIComponent(job.runId)}&job=${encodeURIComponent(job.id)}#${job.docType === "workorder" ? "autoprint-retry-review" : "autoprint-run-history"}`;
  const event = (kind: AlertEvent["kind"], title: string, message: string, state: string, at: Date, next: Date | null): AlertEvent => ({
    eventKey: `job:${job.id}:${kind}`, kind, jobId: job.id, runId: job.runId,
    payload: { title: `${subject} — ${title}`, reason: message, documentType,
      visualId, poNumber: job.hubPoNumber, occurredAt: at.toISOString(),
      retryState: state, nextAttemptAt: next?.toISOString() ?? null, href },
  });
  const at = first?.finishedAt ?? run?.finishedAt ?? now;
  // Preserve first-failure evidence even if all retries finish between collector ticks.
  const nextAttempt = first ? recent.find(a => a.startedAt > first.finishedAt!)?.startedAt ?? null : null;
  const events = [event("failure", firstState === "retry_pending" ? "failed; automatic retry scheduled" : "failure recorded",
    reason, firstState, at, nextAttempt ?? (job.status === "retry_pending" ? job.nextRetryAt : null))];
  const unknownAttempt = failures.find(a => a.outcome === "submission_unknown");
  if (uncertain || unknownAttempt) {
    events.push(event("acceptance_unknown", "printer acceptance unknown",
      `${unknownAttempt?.error ?? job.errorMessage ?? reason} The printer may already have received this document. Verify PrintNode AND the physical printer before any resend. Automatic resending is blocked.`,
      "submission_unknown", unknownAttempt?.finishedAt ?? now, null));
  }
  const manualAttempt = failures.find(a => manualStates.has(a.outcome));
  const needsManual = manualStates.has(job.status) || expiredLease || strandedDocument
    || (job.status === "printed" && !!job.errorMessage);
  if (manualAttempt || (needsManual && !uncertain)) {
    events.push(event("manual_review", "administrator review required",
      manualAttempt?.error ?? job.errorMessage ?? reason,
      manualAttempt?.outcome ?? job.status, manualAttempt?.finishedAt ?? now, null));
  }
  return events;
}

export function runAlertEvents(run: AlertRun, since: Date, now = new Date()): AlertEvent[] {
  if (run.dryRun || run.updatedAt < since) return [];
  const summary = (run.summary ?? {}) as { error?: string; interrupted?: boolean };
  const abandoned = run.startedAt >= since && abandonedRun(run, now);
  if (!summary.error && !summary.interrupted && run.status !== "failed" && !abandoned) return [];
  return [{
    eventKey: `run:${run.id}:failure`, kind: "run_failure", jobId: null, runId: run.id,
    payload: { title: "AutoPrint run requires review", reason: summary.error || (abandoned
      ? "The run worker has not reported a heartbeat for over two minutes. It may have stopped during discovery, before any invoice job was recorded. Check the worker and run history before starting another run; this alert does not restart or resend anything."
      : summary.interrupted
      ? "Run interrupted before completion; review its job outcomes before resending."
      : "Run failed. Review its document outcomes and configuration before taking action."),
      documentType: "Run", visualId: null, poNumber: null,
      occurredAt: (abandoned ? now : run.finishedAt ?? run.updatedAt).toISOString(), retryState: abandoned ? "heartbeat_lost_review_required" : run.status,
      nextAttemptAt: null, href: `/auto-print?run=${encodeURIComponent(run.id)}#autoprint-run-history` },
  }];
}

/** Durable delivery is injected; failures are isolated from every other alert. */
export async function deliverAlertEvents(events: AlertEvent[], insertOnce: (event: AlertEvent) => Promise<void>, failed: (error: unknown) => void) {
  let delivered = true;
  for (const event of events) {
    try { await insertOnce(event); } catch (error) { delivered = false; failed(error); }
  }
  return delivered;
}
