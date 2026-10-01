import { classifyBrowserStartupError } from "./browserLaunch";

export const WORKORDER_MAX_ATTEMPTS = 3;
export const WORKORDER_RETRY_BACKOFF_MS = [1_000, 2_000] as const;
export type AttemptStage = "configuration" | "live_detail" | "renderer_startup" | "render" | "verification" | "reservation" | "submission" | "persistence";
export type AttemptOutcome = "printed" | "dry_run" | "skipped" | "retrying" | "failed" | "submission_unknown" | "prepared";

/**
 * History/UI contract: API job.snapshotMetadata.autoRetry
 * contains this object.
 * One terminal job per workorder, same runId; attemptCount includes the first
 * attempt (maxAttempts=3), not just retries. delayMs is the delay AFTER that
 * attempt, zero for terminal attempts. No queue or manual replay is implied.
 * "prepared" is internal only: a successful read phase continues the SAME
 * attempt through rendering/delivery; only failed reads consume extra attempts.
 */
export interface WorkorderRetryAudit {
  maxAttempts: number;
  attemptCount: number;
  outcome: AttemptOutcome;
  attempts: {
    attempt: number;
    phase: AttemptStage;
    outcome: AttemptOutcome;
    error: string | null;
    delayMs: number;
  }[];
}

export class WorkorderSkip extends Error {}

/** Explicit stage fence: no error from a reservation, send or persistence retries. */
export function retryablePreSubmission(error: unknown, stage: AttemptStage): boolean {
  if (error instanceof WorkorderSkip) return false;
  if (!["live_detail", "renderer_startup", "render", "verification"].includes(stage)) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/not configured|not a Printavo page|redirected off Printavo|no workorder URL|ERR_CERT_|ERR_INVALID_URL|ERR_UNKNOWN_URL_SCHEME/i.test(message)) return false;
  const httpStatus = error && typeof error === "object" && "httpStatus" in error ? error.httpStatus : undefined;
  if (typeof httpStatus === "number") {
    if ([408, 429].includes(httpStatus) || httpStatus >= 500 && httpStatus <= 599) return true;
    if (httpStatus >= 400) return false;
  }
  const reason = error && typeof error === "object" && "reason" in error
    ? String(error.reason) : classifyBrowserStartupError(error);
  if (["executable_not_found", "missing_library", "permission_denied", "sandbox_failure"].includes(reason)) return false;
  if (["timeout", "profile_locked", "resource_exhausted", "protocol_failure", "process_crashed"].includes(reason)) return true;
  // 403 is a known transient Printavo WAF response only in browser rendering.
  if (stage === "render" && /Printavo returned 403\b/.test(message)) return true;
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|fetch failed|net::ERR_(?:CONNECTION_|NETWORK_|TIMED_OUT|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR)|socket hang up|(?:returned|status|HTTP)\s*[:=(]?\s*(?:408|429|5\d\d)\b/i.test(message);
}

export async function runWorkorderAttempts<T extends "printed" | "dry_run" | "prepared">(
  work: (context: { stage(value: AttemptStage): void; markSubmission(): void }) => Promise<T>,
  options: {
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (audit: WorkorderRetryAudit) => Promise<void>;
    /** Failed attempts from earlier read phases of this same workorder/run. */
    previousAttempts?: WorkorderRetryAudit["attempts"];
  } = {},
): Promise<{ outcome: T | "failed" | "skipped" | "submission_unknown"; error: unknown; definitivePreSubmitFailure: boolean; audit: WorkorderRetryAudit }> {
  const previous = options.previousAttempts ?? [];
  if (previous.length >= WORKORDER_MAX_ATTEMPTS || previous.some((item, index) => item.attempt !== index + 1 || item.outcome !== "retrying")) {
    throw new Error("Invalid same-run workorder retry budget");
  }
  const audit: WorkorderRetryAudit = { maxAttempts: WORKORDER_MAX_ATTEMPTS, attemptCount: previous.length, outcome: "failed", attempts: [...previous] };
  for (let attempt = previous.length + 1; attempt <= WORKORDER_MAX_ATTEMPTS; attempt++) {
    let stage: AttemptStage = "configuration";
    let submitted = false;
    audit.attemptCount = attempt;
    try {
      const outcome = await work({
        stage(value) { stage = value; },
        markSubmission() { submitted = true; stage = "submission"; },
      });
      audit.outcome = outcome;
      audit.attempts.push({ attempt, phase: stage, outcome, error: null, delayMs: 0 });
      return { outcome, error: null, definitivePreSubmitFailure: false, audit };
    } catch (error) {
      const retry = !submitted && attempt < WORKORDER_MAX_ATTEMPTS && retryablePreSubmission(error, stage);
      const outcome = submitted ? "submission_unknown" : error instanceof WorkorderSkip ? "skipped" : retry ? "retrying" : "failed";
      const backoffMs = retry ? WORKORDER_RETRY_BACKOFF_MS[attempt - 1]! : 0;
      audit.outcome = outcome;
      audit.attempts.push({ attempt, phase: stage, outcome, error: error instanceof Error ? error.message : String(error), delayMs: backoffMs });
      if (!retry) return { outcome: outcome as "failed" | "skipped" | "submission_unknown", error,
        definitivePreSubmitFailure: !submitted && !["reservation", "persistence"].includes(stage) && outcome !== "skipped", audit };
      // Audit persistence errors abort the run; they must not trigger delivery.
      await options.onRetry?.(audit);
      await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(backoffMs);
    }
  }
  throw new Error("Unreachable workorder retry state");
}