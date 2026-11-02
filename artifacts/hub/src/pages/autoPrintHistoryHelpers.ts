export const RECENT_AUTO_PRINT_RUN_LIMIT = 14;

type DiscoveryRun = { status: string; discoveryState?: string | null; discoveryMessage?: string | null; error?: string | null };

export function isDiscoveryFailure(run: DiscoveryRun): boolean {
  return run.status === "failed" && (run.discoveryState === "failed" ||
    (!run.discoveryState && /^Live auto-print discovery failed\b/.test(run.error ?? "")));
}

export function runDiscoveryMessage(run: DiscoveryRun): string | null {
  if (!isDiscoveryFailure(run)) return run.discoveryMessage ?? null;
  return "Discovery failed — eligible orders will be checked again next cycle while AutoPrint is enabled. The invoice list could not be fetched, so no individual print jobs were created and there is nothing to retry from this run. Matching order count is unknown. Orders must still meet the configured conditions when the next scan runs.";
}

export type HistoryJob = {
  status: string;
  docType: string;
  hubPoId?: string | null;
  hubPoNumber?: string | null;
  reason?: string | null;
  isReprint: boolean;
};

export function retryHistory(metadata: unknown): { count: number; max: number; attempts: { attempt: number; phase: string; outcome: string; error: string | null; delayMs: number }[] } | null {
  if (!metadata || typeof metadata !== "object" || !("autoRetry" in metadata)) return null;
  const audit = metadata.autoRetry;
  if (!audit || typeof audit !== "object" || !("attemptCount" in audit) || !("maxAttempts" in audit) || !("attempts" in audit)) return null;
  if (typeof audit.attemptCount !== "number" || typeof audit.maxAttempts !== "number" || !Array.isArray(audit.attempts)) return null;
  const attempts = audit.attempts.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("attempt" in item) || !("phase" in item) || !("outcome" in item)) return [];
    if (typeof item.attempt !== "number" || typeof item.phase !== "string" || typeof item.outcome !== "string") return [];
    return [{
      attempt: item.attempt, phase: item.phase, outcome: item.outcome,
      error: "error" in item && typeof item.error === "string" ? item.error : null,
      delayMs: "delayMs" in item && typeof item.delayMs === "number" ? item.delayMs : 0,
    }];
  });
  return { count: audit.attemptCount, max: audit.maxAttempts, attempts };
}

export const HISTORY_FILTERS = ["all", "skipped", "reprints", "purchase_orders", "needs_review"] as const;
export type HistoryFilter = typeof HISTORY_FILTERS[number];

export function nextHistoryOffset(lastPageLength: number, pageCount: number, pageSize = 200): number | undefined {
  return lastPageLength === pageSize ? pageCount * pageSize : undefined;
}

export function isPurchaseOrder(job: HistoryJob): boolean {
  return Boolean(job.hubPoId || job.hubPoNumber) || /(^|_)po($|_)|purchase/i.test(job.docType);
}

export function needsReconciliation(job: HistoryJob): boolean {
  return job.status === "pending" || job.status === "submission_unknown" ||
    job.reason === "prior_submission_unresolved" ||
    job.reason === "concurrent_or_previously_reserved_attempt";
}

export function matchesHistoryFilter(job: HistoryJob, filter: HistoryFilter): boolean {
  if (filter === "skipped") return job.status === "skipped" && !isPurchaseOrder(job);
  if (filter === "reprints") return job.isReprint;
  if (filter === "purchase_orders") return isPurchaseOrder(job);
  if (filter === "needs_review") return needsReconciliation(job) || job.status === "failed" || job.reason === "prior_print_baseline_missing";
  return true;
}

export function jobStatusLabel(status: string): string {
  return ({ printed: "Sent to printer", dry_run: "Simulated", submission_unknown: "Submission unknown", pending: "Pending — review required", skipped: "Skipped", failed: "Failed" } as Record<string, string>)[status] ?? status;
}

const REASONS: Record<string, string> = {
  prior_print_baseline_missing: "An earlier print has no comparable line-item baseline. Skipped for manual review; changes cannot be verified safely.",
  no_source_reentry_after_print: "No observed return to an Ordered/source status after the prior print.",
  line_items_unchanged: "Line items are unchanged since the prior print.",
  prior_submission_unresolved: "A prior submission is pending or its outcome is unknown. Reconcile it before any resend.",
  submission_outcome_unknown_manual_reconciliation_required: "The submission outcome is unknown. Check PrintNode and the printer before considering a resend.",
  concurrent_or_previously_reserved_attempt: "Another attempt already reserved this document. Review its outcome before any resend.",
  run_limit_deferred: "Deferred because this run reached its document limit.",
  internal_replacements_invoice_no_workorder: "Internal replacement invoice #22787 — no workorder needed. Its line items remain on the PO.",
  live_detail_missing_or_incomplete: "Current invoice details are missing or incomplete.",
  no_longer_in_source_status: "Invoice is no longer in a configured source status.",
  live_status_unavailable: "Current invoice status could not be verified.",
  source_status_history_unverifiable: "Status history could not be verified safely.",
  line_items_changed_during_render_or_detail_unavailable: "Line items changed while rendering, or current details became unavailable.",
};

export function jobReasonLabel(reason: string | null | undefined): string {
  return reason ? REASONS[reason] ?? reason : "No reason recorded.";
}

export function hasUnrecordedSkips(counts: { skipped?: number; alreadyPrinted: number }, jobs: HistoryJob[]): boolean {
  // Older summaries are hydrated by the API with skipped: 0.
  return (counts.skipped ?? 0) === 0 && counts.alreadyPrinted > 0 && !jobs.some((job) => job.status === "skipped");
}