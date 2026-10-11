import { randomUUID } from "node:crypto";
import { db, pqPrintJobsTable as jobs, pqPrintAttemptsTable as attempts, type PqPrintJob, type InsertPqPrintJob } from "@workspace/db";
import { and, or, eq, ne, inArray, desc, sql, lte } from "drizzle-orm";
import { failureStatusEligible } from "./retryEligibility";
import { nextForbiddenRetry, type ForbiddenRetryState } from "./forbiddenRetry";
import type { AutoPrintRoutingRule } from "./configValidation";
import type { CategoryAssignment } from "./decorationEvidence";

export const RETRY_BLOCKING_STATES = ["pending", "retry_pending", "held", "exhausted", "cancelled", "submission_unknown"];
export const LEASE_MS = 10 * 60_000;
export type RetrySnapshot = {
  orderKind: "invoice" | "quote";
  workorderUrl?: string | null;
  fingerprint?: string | null;
  routingPrepared?: boolean;
  routingRule?: AutoPrintRoutingRule | null;
  categoryAssignments?: CategoryAssignment[];
  categoryFollowupClaimed?: boolean;
  delaysMinutes: number[];
  errorStatusId: string | null;
  forbiddenRetry?: ForbiddenRetryState;
  manualOneShot?: boolean;
};
export function retrySnapshot(job: PqPrintJob): RetrySnapshot {
  const value = (job.snapshotMetadata as { durableRetry?: RetrySnapshot } | null)?.durableRetry;
  if (!value || !["invoice", "quote"].includes(value.orderKind)) throw new Error("Retry snapshot missing; operator recovery required");
  return value;
}
export async function enqueuePrint(values: InsertPqPrintJob, snapshot: RetrySnapshot): Promise<PqPrintJob | null> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`visual:${values.visualId}`}, 0))`);
    const history = await tx.select().from(jobs).where(and(eq(jobs.docType, "workorder"),
      or(eq(jobs.printavoOrderId, values.printavoOrderId), eq(jobs.visualId, values.visualId!)),
      inArray(jobs.status, [...RETRY_BLOCKING_STATES, "printed"])))
      .orderBy(desc(sql`coalesce(${jobs.printedAt}, ${jobs.createdAt})`), desc(jobs.id));
    if (history.some(j => RETRY_BLOCKING_STATES.includes(j.status)) ||
      (history.find(j => j.status === "printed")?.id ?? null) !== (values.priorJobId ?? null)) return null;
    const initialFailure = !!values.errorMessage;
    const delay = snapshot.delaysMinutes[0];
    const status = initialFailure && delay === undefined ? (values.priorJobId ? "held" : "exhausted") : "retry_pending";
    const [row] = await tx.insert(jobs).values({
      ...values, status, retryManaged: true, retryPhase: values.retryPhase ?? "queued",
      nextRetryAt: status !== "retry_pending" ? null : new Date(Date.now() + (initialFailure ? delay * 60_000 : 0)),
      snapshotMetadata: { durableRetry: snapshot },
    }).onConflictDoNothing().returning();
    if (row && initialFailure) await tx.insert(attempts).values({
      jobId: row.id, attempt: 1, leaseToken: randomUUID(), actor: "run",
      phase: values.retryPhase ?? "live_detail", outcome: status, error: values.errorMessage, finishedAt: new Date(),
    });
    return row ?? null;
  });
}

/** Atomic expired-lease recovery. A process that crossed the send fence can NEVER be reclaimed. */
export async function recoverPrintLeases() {
  await db.transaction(async tx => {
    const expired = await tx.select().from(jobs).where(and(eq(jobs.retryManaged, true),
      eq(jobs.status, "pending"), lte(jobs.leaseUntil, new Date()))).for("update", { skipLocked: true });
    for (const job of expired) {
      const unknown = job.retryPhase === "submitting";
      const snapshot = retrySnapshot(job);
      const forbidden = !unknown && !snapshot.manualOneShot && snapshot.forbiddenRetry
        ? nextForbiddenRetry(snapshot.forbiddenRetry) : undefined;
      const exhausted = snapshot.manualOneShot || (forbidden ? forbidden.delayMs === null : job.retryCount > snapshot.delaysMinutes.length);
      const status = unknown ? "submission_unknown" : exhausted ? (failureStatusEligible(job) ? "exhausted" : "held") : "retry_pending";
      await tx.update(jobs).set({ status, leaseToken: null, leaseUntil: null,
        nextRetryAt: status === "retry_pending" ? new Date(Date.now() + (forbidden?.delayMs ?? 0)) : null,
        ...(forbidden ? { snapshotMetadata: { ...(job.snapshotMetadata as object), durableRetry: { ...snapshot, forbiddenRetry: forbidden } } } : {}),
        errorMessage: unknown ? "Worker interrupted after submission fence; reconcile in PrintNode before any resend."
          : "Worker lease expired before submission; safe to retry." }).where(eq(jobs.id, job.id));
      await tx.update(attempts).set({ outcome: status, error: "Worker lease expired", finishedAt: new Date() })
        .where(and(eq(attempts.jobId, job.id), eq(attempts.leaseToken, job.leaseToken!)));
    }
  });
}

export async function claimPrint(id: string, actor: string) {
  return db.transaction(async tx => {
    const token = randomUUID();
    const [job] = await tx.update(jobs).set({ status: "pending", retryPhase: "verification",
      leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), nextRetryAt: null,
      retryCount: sql`${jobs.retryCount} + 1` })
      .where(and(eq(jobs.id, id), eq(jobs.retryManaged, true), eq(jobs.status, "retry_pending"),
        lte(jobs.nextRetryAt, new Date()))).returning();
    if (!job) return null;
    await tx.insert(attempts).values({ jobId: id, attempt: job.retryCount, leaseToken: token,
      actor, phase: "verification", outcome: "running" });
    return job;
  });
}
export async function fencePrint(job: PqPrintJob, phase: string) {
  const [row] = await db.update(jobs).set({ retryPhase: phase, leaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(jobs.id, job.id), eq(jobs.leaseToken, job.leaseToken!), eq(jobs.status, "pending"),
      sql`${jobs.leaseUntil} > now()`)).returning();
  if (!row) throw new Error("Print lease lost; submission refused");
  await db.update(attempts).set({ phase }).where(and(eq(attempts.jobId, job.id), eq(attempts.leaseToken, job.leaseToken!)));
}
export async function finishPrint(job: PqPrintJob, patch: Partial<InsertPqPrintJob>) {
  return db.transaction(async tx => {
    const [row] = await tx.update(jobs).set({ ...patch, leaseToken: null, leaseUntil: null })
      .where(and(eq(jobs.id, job.id), eq(jobs.leaseToken, job.leaseToken!), eq(jobs.status, "pending"))).returning();
    if (!row) throw new Error("Print lease lost while saving outcome; do not resubmit");
    await tx.update(attempts).set({ phase: patch.retryPhase ?? job.retryPhase!, outcome: patch.status!,
      error: patch.errorMessage ?? null, finishedAt: new Date() })
      .where(and(eq(attempts.jobId, job.id), eq(attempts.leaseToken, job.leaseToken!)));
    return row;
  });
}
export async function listRetryJobs() {
  const rows = await db.select().from(jobs).where(and(eq(jobs.docType, "workorder"),
    or(eq(jobs.retryManaged, true), inArray(jobs.status, ["failed", "held", "submission_unknown"]))))
    .orderBy(sql`case when ${jobs.status} in ('printed', 'cancelled') then 1 else 0 end`, desc(jobs.createdAt)).limit(200);
  const history = rows.length ? await db.select().from(attempts).where(inArray(attempts.jobId, rows.map(j => j.id)))
    .orderBy(desc(attempts.startedAt)) : [];
  return rows.map(job => ({ ...job, attempts: history.filter(a => a.jobId === job.id) }));
}

/** Administrative operations cannot steal an active lease or release an uncertain send. */
export async function changeRetryState(id: string, action: "retry" | "cancel", actor: string) {
  return db.transaction(async tx => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for("update");
    if (!job || !job.retryManaged || job.printnodeJobId || !["retry_pending", "held", "exhausted", "cancelled"].includes(job.status)) {
      throw new Error("Job cannot be retried/cancelled: accepted, active, or uncertain submissions require reconciliation.");
    }
    if (action === "retry") {
      retrySnapshot(job);
      if (job.retryPhase === "reconciled_not_sent") throw new Error("Stage an explicit recovery before retrying this reconciled submission.");
    }
    const [row] = await tx.update(jobs).set({ status: action === "cancel" ? "cancelled" : "retry_pending",
      nextRetryAt: action === "retry" ? new Date() : null,
      ...(action === "retry" ? { snapshotMetadata: {
        ...(job.snapshotMetadata as object), durableRetry: { ...retrySnapshot(job), manualOneShot: true },
      } } : {}),
      // A manual retry is one explicit attempt, never a reset of the automatic budget.
      errorMessage: action === "cancel" ? "Cancelled by operator; discovery will not requeue this order." : job.errorMessage,
    }).where(and(eq(jobs.id, id), ne(jobs.status, "pending"))).returning();
    await tx.insert(attempts).values({ jobId: id, attempt: job.retryCount, leaseToken: randomUUID(),
      phase: "operator", outcome: action, actor, finishedAt: new Date() });
    return row;
  });
}
