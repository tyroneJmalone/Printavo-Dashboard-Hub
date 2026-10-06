import { randomUUID } from "node:crypto";
import { db, pqPrintJobsTable as jobs, pqPrintAttemptsTable as attempts, pvOrdersTable, type PqPrintJob } from "@workspace/db";
import { eq, and, or, ne, inArray, sql, desc } from "drizzle-orm";
import { getAutoPrintConfig } from "./config";
import { changeRetryState, RETRY_BLOCKING_STATES, retrySnapshot } from "./retryStore";
import { executePrintAttempt, finalizePrintAttempt, liveRetryDependencies, refreshRetryRun } from "./retryWorker";
import { lineItemFingerprint } from "./candidatePlanning";
import { isInternalReplacementInvoice } from "../../purchasing/internalInvoicePolicy";
import type { Logger } from "pino";

export interface RetryAction {
  action: "retry" | "cancel" | "recover" | "confirm_accepted" | "confirm_not_sent" | "fail";
  expectedStatusId?: string;
  confirmedNotSubmitted?: boolean;
  printnodeJobId?: string;
  note?: string;
}
export async function applyRetryAction(id: string, input: RetryAction, actor: string, log: Logger) {
  if (input.action === "retry" || input.action === "cancel") {
    const job = await changeRetryState(id, input.action, actor);
    if (input.action === "retry") {
      // An explicit manual action is allowed in development; it is not a scheduler.
      const result = await executePrintAttempt(id, actor);
      if (result) await finalizePrintAttempt(result, log);
    }
    await refreshRetryRun(job.runId);
    return;
  }
  if (!input.note?.trim()) throw new Error("An operator verification note is required");
  const [old] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!old || old.docType !== "workorder" || isInternalReplacementInvoice(old.visualId)) throw new Error("Workorder not eligible for recovery");
  if (old.printnodeJobId || old.status === "printed" || old.status === "pending") throw new Error("Accepted or active jobs cannot be replayed");
  if (input.action === "confirm_accepted" || input.action === "confirm_not_sent") {
    if (old.status !== "submission_unknown") throw new Error("Only uncertain submissions need reconciliation");
    if (input.action === "confirm_accepted" && !/^[1-9]\d*$/.test(input.printnodeJobId ?? "")) throw new Error("Verified PrintNode job ID is required");
    if (input.action === "confirm_not_sent" && input.confirmedNotSubmitted !== true) throw new Error("Confirm in PrintNode and at the printer that nothing was submitted");
    await db.transaction(async tx => {
      const [row] = await tx.update(jobs).set(input.action === "confirm_accepted"
        ? { status: "printed", printnodeJobId: input.printnodeJobId, printedAt: new Date(), retryPhase: "accepted", nextRetryAt: null }
        : { status: "held", retryPhase: "reconciled_not_sent", nextRetryAt: null, errorMessage: "Operator verified not submitted. Explicit recovery required before another attempt." })
        .where(and(eq(jobs.id, id), eq(jobs.status, "submission_unknown"))).returning();
      if (!row) throw new Error("Job changed during reconciliation");
      await tx.insert(attempts).values({ jobId: id, attempt: old.retryCount, leaseToken: randomUUID(),
        phase: "reconciliation", outcome: input.action, error: input.note, actor, finishedAt: new Date() });
    });
    await refreshRetryRun(old.runId);
    return; // Reconciliation itself never prints or mutates Printavo.
  }
  if (!["failed", "held", "exhausted", "cancelled", "retry_pending"].includes(old.status)) throw new Error("Job is not recoverable");
  if (input.action === "fail") {
    await db.transaction(async tx => {
      const [row] = await tx.update(jobs).set({ status: "exhausted", nextRetryAt: null, errorMessage: `Operator stopped retries: ${input.note}` })
        .where(and(eq(jobs.id, id), eq(jobs.status, old.status), eq(jobs.retryManaged, true))).returning();
      if (!row) throw new Error("Job changed or is legacy; recover it first");
      await tx.insert(attempts).values({ jobId: id, attempt: old.retryCount, leaseToken: randomUUID(),
        phase: "operator", outcome: "exhausted", error: input.note, actor, finishedAt: new Date() });
    });
    await finalizePrintAttempt({ ...old, status: "exhausted" }, log);
    return;
  }
  if (!input.confirmedNotSubmitted || !input.expectedStatusId) throw new Error("Recovery requires confirmation of no submission and the exact current status ID");
  const config = await getAutoPrintConfig();
  const [mirror] = await db.select().from(pvOrdersTable).where(eq(pvOrdersTable.printavoId, old.printavoOrderId));
  const kind = old.retryManaged ? retrySnapshot(old).orderKind : mirror?.orderType === "quote" ? "quote" : "invoice";
  const current = await liveRetryDependencies.status(kind, old.printavoOrderId);
  if (!current || current.orderId !== old.printavoOrderId || String(current.visualId) !== old.visualId ||
    current.statusId !== input.expectedStatusId) throw new Error(`Status conflict: current status is ${current?.statusName ?? "unknown"} (${current?.statusId ?? "unknown"}). Nothing was queued. Enter that exact status ID to authorize printing there without changing it.`);
  const data = await liveRetryDependencies.detail(kind, old.printavoOrderId);
  const node = data.invoice ?? data.quote;
  if (!node || node.id !== old.printavoOrderId || String(node.visualId) !== old.visualId ||
    node.lineItemGroups.pageInfo.hasNextPage || node.lineItemGroups.nodes.some(g => g.lineItems.pageInfo.hasNextPage)) throw new Error("Complete live order detail required");
  const fingerprint = lineItemFingerprint(node.lineItemGroups.nodes.flatMap(g => g.lineItems.nodes.map(l => ({ ...l }))));
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`visual:${old.visualId}`}, 0))`);
    const history = await tx.select().from(jobs).where(and(ne(jobs.id, id), eq(jobs.docType, "workorder"),
      or(eq(jobs.printavoOrderId, old.printavoOrderId), eq(jobs.visualId, old.visualId!)),
      inArray(jobs.status, [...RETRY_BLOCKING_STATES, "printed"]))).orderBy(desc(jobs.printedAt), desc(jobs.id));
    if (history.some(j => RETRY_BLOCKING_STATES.includes(j.status))) throw new Error("Another unresolved job blocks recovery");
    const prior = history.find(j => j.status === "printed");
    if (prior && (prior.id !== old.priorJobId || !old.eligibilityCycle?.startsWith("entry:") ||
      !prior.contentFingerprint || fingerprint === prior.contentFingerprint)) throw new Error("Recovery cannot bypass changed-lines and source-reentry reprint eligibility");
    const [row] = await tx.update(jobs).set({ retryManaged: true, status: "held", retryPhase: "recovered",
      // Recovery only stages a reviewed snapshot. A second explicit Retry now
      // action is necessary; it cannot be picked up by the scheduler.
      nextRetryAt: null, sourceStatusId: current.statusId, sourceStatusName: current.statusName,
      contentFingerprint: fingerprint, printerId: old.printerId ?? config.printerId, printerName: old.printerName ?? config.printerName,
      snapshotMetadata: { ...(old.snapshotMetadata as object ?? {}), durableRetry: {
        orderKind: kind, fingerprint, routingPrepared: false, workorderUrl: node.workorderUrl, delaysMinutes: config.retryDelaysMinutes,
        errorStatusId: config.errorStatusId, originalSourceStatusId: old.sourceStatusId,
      } }, errorMessage: "Recovery staged at the explicitly approved current status. Retry now to submit; no status has been changed.",
    }).where(and(eq(jobs.id, id), eq(jobs.status, old.status))).returning();
    if (!row) throw new Error("Job changed during recovery");
    await tx.insert(attempts).values({ jobId: id, attempt: old.retryCount, leaseToken: randomUUID(),
      phase: "operator", outcome: "recovered", error: input.note, actor, finishedAt: new Date() });
  });
  await refreshRetryRun(old.runId);
}
