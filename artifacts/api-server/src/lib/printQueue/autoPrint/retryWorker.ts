import { db, pqPrintJobsTable as jobs, pqPrintRunsTable as runs, changeEventsTable, type PqPrintJob } from "@workspace/db";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { singleOrderDetailQuery, type SingleOrderDetail } from "@workspace/printavo";
import { getPrintavoClient } from "../../printavoGateway";
import { fetchLiveOrderStatus } from "./liveDiscovery";
import { checkPrintSafety } from "./printSafety";
import { openPdfRenderer } from "./pdf";
import { submitPdfPrintJob, printNodeConfigured } from "./printNode";
import { loadPurchaseNotes } from "./purchaseNotes";
import { lineItemFingerprint, verifiedConversionOrderIds } from "./candidatePlanning";
import { retryablePreSubmission, WorkorderSkip, type AttemptStage } from "./workorderRetry";
import { claimPrint, fencePrint, finishPrint, retrySnapshot, recoverPrintLeases } from "./retryStore";
import { getAutoPrintConfig } from "./config";
import { startPqStatusJob } from "../statusJobs";
import { runHubPoBatch } from "./hubPoBatch";
import { classifyDecorationLines, destinationMappingForClassification } from "../../purchasing/decorationClassifier";
import { conditionalAutoPrintDestination } from "./routing";
import { businessDaysUntilDue } from "../../purchasing/businessDays";
import { prepareRetry } from "./retryPreparation";
import { failureStatusEligible } from "./retryEligibility";
import { isWorkorder403, nextForbiddenRetry, forbiddenRetryMessage } from "./forbiddenRetry";

// Explicit dependencies allow failure injection without loading a renderer,
// sending a PrintNode job, or changing a real Printavo status.
export const liveRetryDependencies = {
  claim: claimPrint, fence: fencePrint, finish: finishPrint,
  status: fetchLiveOrderStatus,
  detail: (kind: "invoice" | "quote", id: string) => getPrintavoClient().query<SingleOrderDetail & {
    invoice?: NonNullable<SingleOrderDetail["invoice"]> & { workorderUrl?: string; nickname?: string; customerDueAt?: string };
    quote?: NonNullable<SingleOrderDetail["quote"]> & { workorderUrl?: string; nickname?: string; customerDueAt?: string };
  }>(singleOrderDetailQuery(kind, id).replace(/visualId\b/, "visualId workorderUrl nickname customerDueAt")),
  render: async (url: string, job: PqPrintJob) => {
    const renderer = await openPdfRenderer({ maxStartupAttempts: 1 });
    try { return await renderer.renderUrl(url, {
      purchaseNotes: await loadPurchaseNotes(job.printavoOrderId), excludeAttachments: true, isReprint: job.isReprint,
      nickname: job.nickname,
    }); } finally { await renderer.close().catch(() => undefined); }
  },
  submit: submitPdfPrintJob,
  configured: printNodeConfigured,
  prepare: prepareRetry,
};
export type RetryDependencies = typeof liveRetryDependencies;

export async function executePrintAttempt(id: string, actor: string, deps: RetryDependencies = liveRetryDependencies) {
  let result = await executeSinglePrintAttempt(id, actor, deps);
  // Only short intra-round retries are driven here. The 15-minute cooldown is
  // persisted and picked up by the production scheduler, never an in-memory timer.
  for (let i = 0; i < 2 && result?.status === "retry_pending"; i++) {
    const snapshot = retrySnapshot(result);
    const wait = snapshot.forbiddenRetry?.delayMs;
    if (snapshot.manualOneShot || wait == null || wait > 2000) break;
    const sleepMs = Math.max(0, (result.nextRetryAt?.getTime() ?? Date.now()) - Date.now());
    await new Promise(resolve => setTimeout(resolve, sleepMs));
    const next = await executeSinglePrintAttempt(id, actor, deps);
    if (!next) break; // Another worker claimed it; never steal its lease.
    result = next;
  }
  return result;
}

async function executeSinglePrintAttempt(id: string, actor: string, deps: RetryDependencies) {
  let job = await deps.claim(id, actor);
  if (!job) return null;
  let phase: AttemptStage = "verification";
  let submitted = false;
  let accepted: number | null = null;
  const snapshot = retrySnapshot(job);
  const check = async (job: PqPrintJob) => {
    const safety = checkPrintSafety({ dryRun: false,
      observedStatus: await deps.status(snapshot.orderKind, job.printavoOrderId),
      expected: { orderId: job.printavoOrderId, visualId: Number(job.visualId), sourceStatusId: job.sourceStatusId! } });
    if (!safety.allowed) throw new WorkorderSkip(`Held for review: ${safety.reason}. Restore the original source status or explicitly authorize recovery at the current status.`);
  };
  try {
    if (!job.sourceStatusId || !job.visualId || !job.printerId || !deps.configured() ||
      !Number.isSafeInteger(Number(job.printerId)) || Number(job.printerId) <= 0) {
      throw new WorkorderSkip("Printer, source status, or order identity missing; review configuration.");
    }
    await check(job);
    phase = "live_detail";
    const data = await deps.detail(snapshot.orderKind, job.printavoOrderId);
    const node = data.invoice ?? data.quote;
    if (!node || node.id !== job.printavoOrderId || Number(node.visualId) !== Number(job.visualId) ||
      node.lineItemGroups.pageInfo.hasNextPage || node.lineItemGroups.nodes.some(g => g.lineItems.pageInfo.hasNextPage)) {
      throw new WorkorderSkip("Live identity or complete line items could not be verified");
    }
    const fingerprint = lineItemFingerprint(node.lineItemGroups.nodes.flatMap(g => g.lineItems.nodes.map(l => ({ ...l }))));
    if (snapshot.fingerprint && snapshot.fingerprint !== fingerprint) throw new WorkorderSkip("Line items changed since queueing; review and recover with a fresh snapshot.");
    job = await deps.prepare(job, fingerprint, node);
    phase = "render";
    await deps.fence(job, phase);
    if (!node.workorderUrl) throw new Error("No workorder URL on this order");
    // Use the live nickname on every attempt, not the possibly older queued value.
    const pdf = await deps.render(node.workorderUrl, { ...job, nickname: node.nickname ?? null });
    phase = "verification";
    await check(job);
    const verifyData = await deps.detail(snapshot.orderKind, job.printavoOrderId);
    const verify = verifyData.invoice ?? verifyData.quote;
    if (!verify || verify.id !== job.printavoOrderId || Number(verify.visualId) !== Number(job.visualId) ||
      verify.lineItemGroups.pageInfo.hasNextPage || verify.lineItemGroups.nodes.some(g => g.lineItems.pageInfo.hasNextPage) ||
      lineItemFingerprint(verify.lineItemGroups.nodes.flatMap(g => g.lineItems.nodes.map(l => ({ ...l })))) !== fingerprint) {
      throw new WorkorderSkip("Line items changed during rendering; no print was submitted");
    }
    await check(job);
    // This committed fence precedes the irreversible POST. A crash on either
    // side of the POST becomes uncertain, never an automatic resend.
    await deps.fence(job, "submitting");
    submitted = true;
    phase = "submission";
    accepted = await deps.submit({ printerId: Number(job.printerId), copies: job.copies,
      title: `${job.isReprint ? "UPDATED / REPRINT — " : ""}Workorder #${job.visualId}${job.nickname ? ` — ${job.nickname}` : ""}`,
      pdfBase64: pdf.toString("base64"), source: `Printavo Hub auto-print ${job.id}` });
    if (!Number.isSafeInteger(accepted) || accepted <= 0) { accepted = null; throw new Error("PrintNode returned no valid job id"); }
    phase = "persistence";
    return await deps.finish(job, { status: "printed", retryPhase: "accepted", printnodeJobId: String(accepted),
      printedAt: new Date(), contentFingerprint: fingerprint, errorMessage: null, nextRetryAt: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Even a persistence failure after acceptance cannot become retryable.
    const currentSnapshot = retrySnapshot(job); // preparation may have refreshed fingerprint/routing
    const temporary = retryablePreSubmission(error, phase);
    const forbidden = !submitted && !currentSnapshot.manualOneShot && temporary &&
      (currentSnapshot.forbiddenRetry || isWorkorder403(error, phase))
      ? nextForbiddenRetry(currentSnapshot.forbiddenRetry) : undefined;
    const delayMs = forbidden ? forbidden.delayMs :
      currentSnapshot.delaysMinutes[job.retryCount - 1] === undefined ? null :
        currentSnapshot.delaysMinutes[job.retryCount - 1] * 60_000;
    const retry = !submitted && !currentSnapshot.manualOneShot && temporary && delayMs !== null;
    const status = accepted ? "printed" : submitted ? "submission_unknown"
      : error instanceof WorkorderSkip ? "held" : retry ? "retry_pending" : failureStatusEligible(job) ? "exhausted" : "held";
    return deps.finish(job, { status, retryPhase: accepted ? "accepted" : submitted ? "submitting" : phase,
      errorMessage: forbidden ? `${forbiddenRetryMessage(forbidden)} ${message}` : message,
      nextRetryAt: retry ? new Date(Date.now() + delayMs!) : null,
      ...(forbidden ? { snapshotMetadata: { ...(job.snapshotMetadata as object),
        durableRetry: { ...currentSnapshot, forbiddenRetry: forbidden } } } : {}),
      ...(accepted ? { printnodeJobId: String(accepted), printedAt: new Date() } : {}) });
  }
}

/** Only after a durable accepted result; failures here must never resend a workorder. */
export async function finalizePrintAttempt(job: PqPrintJob, log: Logger, deps = {
  status: fetchLiveOrderStatus, advance: startPqStatusJob, po: runHubPoBatch,
}) {
  const snapshot = retrySnapshot(job);
  if (job.status === "exhausted" && !failureStatusEligible(job)) {
    await db.update(jobs).set({ status: "held", nextRetryAt: null,
      errorMessage: `${job.errorMessage ?? ""} Prior print eligibility is unverified; failure status withheld for review.`,
    }).where(and(eq(jobs.id, job.id), eq(jobs.status, "exhausted")));
    await refreshRetryRun(job.runId);
    return;
  }
  try {
    if (job.status === "printed") {
      const conversions = await db.select().from(changeEventsTable).where(and(eq(changeEventsTable.entityId, job.printavoOrderId),
        eq(changeEventsTable.eventType, "converted"), eq(changeEventsTable.entityType, "order")));
      let renderer: Awaited<ReturnType<typeof openPdfRenderer>> | null = null;
      try {
        const result = await deps.po({ runId: job.runId, dryRun: false, printerId: job.printerId!, printerName: job.printerName,
          successfullyPrintedOrders: [{ orderId: job.printavoOrderId, visualId: Number(job.visualId),
            isReprint: job.isReprint, priorPrintedAt: job.priorPrintedAt,
            verifiedSnapshotOrderIds: verifiedConversionOrderIds({ orderId: job.printavoOrderId, visualId: Number(job.visualId) }, conversions) }],
          renderPdf: async html => { renderer ??= await openPdfRenderer({ maxStartupAttempts: 1 }); return renderer.renderHtml(html); },
        });
        if (result.warnings.length) throw new Error(result.warnings.join("; "));
      } finally { const active = renderer as Awaited<ReturnType<typeof openPdfRenderer>> | null; await active?.close(); }
    }
  } catch (error) {
    await db.update(jobs).set({ errorMessage: `Workorder accepted; PO follow-up requires review: ${String(error)}` }).where(eq(jobs.id, job.id));
    log.warn({ err: error, jobId: job.id }, "Auto-print PO follow-up failed; workorder will not retry");
  }
  try {
    let target = job.status === "printed" ? job.targetStatusId : job.status === "exhausted" ? snapshot.errorStatusId : null;
    // Preparatory failures have no destination snapshot. Resolve routing from
    // authoritative detail only after the workorder was accepted.
    if (job.status === "printed" && !target && (!snapshot.fingerprint || snapshot.routingPrepared === false)) {
      const config = await getAutoPrintConfig();
      const data = await liveRetryDependencies.detail(snapshot.orderKind, job.printavoOrderId);
      const node = data.invoice ?? data.quote;
      if (node) {
        const classification = classifyDecorationLines(node.lineItemGroups.nodes.flatMap(g => g.lineItems.nodes)
          .map(l => ({ categoryName: l.category?.name ?? null, items: l.items })), { positiveQuantityOnly: true });
        target = config.routingMode === "conditional"
          ? conditionalAutoPrintDestination(config.routingRules, { classification, nickname: node.nickname ?? null,
            businessDaysOut: node.customerDueAt ? businessDaysUntilDue(new Date(), new Date(node.customerDueAt)) : null })?.statusId ?? null
          : destinationMappingForClassification(classification, config.categoryMappings)?.statusId ?? null;
      }
    }
    if (target && target !== job.sourceStatusId) {
      const safety = checkPrintSafety({ dryRun: false, observedStatus: await deps.status(snapshot.orderKind, job.printavoOrderId),
        expected: { orderId: job.printavoOrderId, visualId: Number(job.visualId), sourceStatusId: job.sourceStatusId! } });
      if (!safety.allowed) throw new Error(`Status advance held: ${safety.reason}`);
      const result = await deps.advance("autoprint", [{ orderId: job.printavoOrderId, targetStatusId: target, expectedStatusId: job.sourceStatusId! }], log);
      if (result.status !== "started") throw new Error(`Status advance not started: ${result.status}; move manually after review`);
    }
  } catch (error) {
    await db.update(jobs).set({ errorMessage: `${job.errorMessage ?? ""} Status follow-up requires review: ${String(error)}` }).where(eq(jobs.id, job.id));
  }
  await refreshRetryRun(job.runId);
}
export async function refreshRetryRun(runId: string) {
  const rows = await db.select().from(jobs).where(eq(jobs.runId, runId));
  const pending = rows.filter(j => ["pending", "retry_pending", "held", "submission_unknown"].includes(j.status)).length;
  const failed = rows.filter(j => ["failed", "exhausted", "cancelled"].includes(j.status)).length;
  // Preserve discovery/run metadata and counts belonging to other document types.
  await db.update(runs).set({
    status: pending ? "pending" : failed ? "failed" : "success",
    updatedAt: new Date(),
    summary: sql`jsonb_set(jsonb_set(jsonb_set(${runs.summary}, '{counts,pending}', to_jsonb(${pending}::int)), '{counts,failed}', to_jsonb(${failed}::int)), '{counts,printed}', to_jsonb(${rows.filter(j => j.status === "printed" && j.docType !== "hub_po").length}::int))`,
  }).where(and(eq(runs.id, runId), sql`${runs.status} <> 'running'`));
}
export async function processDuePrintRetries(log: Logger) {
  if (process.env.NODE_ENV !== "production") return;
  const config = await getAutoPrintConfig();
  if (!config.enabled || config.dryRun) return;
  await recoverPrintLeases();
  const due = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.retryManaged, true),
    eq(jobs.status, "retry_pending"), lte(jobs.nextRetryAt, new Date()))).limit(30);
  for (const { id } of due) {
    try { const result = await executePrintAttempt(id, "scheduler"); if (result) await finalizePrintAttempt(result, log); }
    catch (error) { log.error({ err: error, jobId: id }, "Durable print retry failed; lease recovery will reconcile"); }
  }
}
