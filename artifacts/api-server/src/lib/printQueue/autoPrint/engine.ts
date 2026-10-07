import { loadPurchaseNotes } from "./purchaseNotes";
import type { Logger } from "pino";
import {
  db,
  pqPrintRunsTable,
  pqPrintJobsTable,
  pvOrdersTable,
  changeEventsTable,
  pvStatusesTable,
  type PqPrintRun,
  type PqPrintJob,
} from "@workspace/db";
import { eq, desc, inArray, and, or, sql } from "drizzle-orm";
import { upsertOrder } from "../../sync/upserts";
import { applyOrderDetail, newDetailAgg } from "../../sync/detail";
import { singleOrderDetailQuery, type SingleOrderDetail, type PvOrderDetailNode } from "@workspace/printavo";
import { getPrintavoClient } from "../../printavoGateway";
import { getAutoPrintConfig, type AutoPrintConfig } from "./config";
import { openPdfRenderer, type PdfRenderer } from "./pdf";
import {
  printNodeConfigured,
  submitPdfPrintJob,
} from "./printNode";
import { startPqStatusJob, type PqJobLineInput } from "../statusJobs";
import {
  discoverLiveAutoPrintOrders,
  fetchLiveOrderStatus,
  LiveDiscoveryError,
} from "./liveDiscovery";
import { checkPrintSafety, selectAutoPrintWorkorders, INTERNAL_REPLACEMENT_WORKORDER_SKIP_REASON } from "./printSafety";
import { isInternalReplacementInvoice } from "../../purchasing/internalInvoicePolicy";
import { decideReprint, lineItemFingerprint, printAttemptKey, canReservePrint, observedSourceMembership, hubPoOrdersFromOutcomes, definitiveFailureCandidates, verifiedConversionOrderIds } from "./candidatePlanning";
import {
  classifyDecorationLines,
  destinationMappingForClassification,
} from "../../purchasing/decorationClassifier";
import { businessDaysUntilDue } from "../../purchasing/businessDays";
import {
  conditionalAutoPrintDestination,
  successfulPostPrintCandidates,
} from "./routing";
import { runWorkorderAttempts, WorkorderSkip, type WorkorderRetryAudit } from "./workorderRetry";
import { runHubPoBatch } from "./hubPoBatch";
import { claimReplacementSlips } from "./replacementSlipQueue";
import { runReplacementSlipBatch } from "./replacementSlipBatch";
import { enqueuePrint, RETRY_BLOCKING_STATES } from "./retryStore";
import { executePrintAttempt, finalizePrintAttempt, refreshRetryRun } from "./retryWorker";
import { retryablePreSubmission } from "./workorderRetry";

export { PDF_RENDERER_STARTUP_ERROR_PREFIX } from "./rendererStartupGuard";

/**
 * Auto-print engine (PQ3a). One run at a time (in-memory claim slot,
 * pq_status_jobs pattern). Per-order outcomes are persisted to
 * pq_print_jobs, with a durable locked reservation before delivery. Pending
 * or ambiguous submissions block further automatic delivery after a restart.
 *
 * Printavo writes (post-print status advance) go EXCLUSIVELY through
 * startPqStatusJob('autoprint', ...) — same stale guard, same throttled
 * gateway, no second write path.
 *
 * SAFETY: config defaults enabled=false + dryRun=true. Dry runs render
 * real PDFs (pipeline check) but never touch PrintNode or Printavo.
 */

const MAX_ORDERS_PER_RUN = 30;
/** Pause between order renders — polite to Printavo's WAF. */
const INTER_ORDER_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── In-memory claim slot ────────────────────────────────────────────── */

let activeRunId: string | null = null;

export function isRunActive(id: string): boolean {
  return activeRunId === id;
}

export function anyRunActive(): boolean {
  return activeRunId !== null;
}

/* ── Summary / DTO shapes ────────────────────────────────────────────── */

export interface RunCounts {
  pending: number;
  skipped: number;
  reprinted: number;
  poPrinted: number;
  poFailed: number;
  candidates: number;
  alreadyPrinted: number;
  detailPending: number;
  deferred: number;
  printed: number;
  failed: number;
  dryRun: number;
}

interface RunSummary {
  discoveryState?: "checking" | "complete" | "failed" | null;
  discoveryMessage?: string | null;
  counts: RunCounts;
  dryRun: boolean;
  interrupted?: boolean;
  error?: string | null;
  advanceJobId?: string | null;
  advanceSkipped?: string | null;
  printerId?: string | null;
  printerName?: string | null;
}

export interface PqPrintRunDto {
  discoveryState: "checking" | "complete" | "failed" | null;
  discoveryMessage: string | null;
  id: string;
  trigger: string;
  dryRun: boolean;
  /** running | success | failed | interrupted (computed). */
  status: string;
  startedAt: string;
  finishedAt: string | null;
  counts: RunCounts;
  error: string | null;
  advanceJobId: string | null;
  advanceSkipped: string | null;
  createdAt: string;
}

export interface PqPrintJobDto {
  reason: string | null;
  priorJobId: string | null;
  priorPrintedAt: string | null;
  contentFingerprint: string | null;
  eligibilityCycle: string | null;
  hubPoId: string | null;
  hubPoNumber: string | null;
  snapshotMetadata: unknown;
  id: string;
  runId: string;
  orderId: string;
  visualId: number | null;
  nickname: string | null;
  docType: string;
  sourceStatusId: string | null;
  sourceStatusName: string | null;
  targetStatusId: string | null;
  targetStatusName: string | null;
  printnodeJobId: string | null;
  printerName: string | null;
  copies: number;
  status: string;
  errorMessage: string | null;
  isReprint: boolean;
  printedAt: string | null;
  createdAt: string;
}

const EMPTY_COUNTS: RunCounts = {
  pending: 0,
  skipped: 0,
  reprinted: 0,
  poPrinted: 0,
  poFailed: 0,
  candidates: 0,
  alreadyPrinted: 0,
  detailPending: 0,
  deferred: 0,
  printed: 0,
  failed: 0,
  dryRun: 0,
};

function readSummary(row: PqPrintRun): RunSummary {
  const s = (row.summary ?? {}) as Partial<RunSummary>;
  return {
    counts: { ...EMPTY_COUNTS, ...(s.counts ?? {}) },
    dryRun: row.dryRun,
    interrupted: s.interrupted,
    discoveryMessage: s.discoveryMessage ?? null,
    discoveryState: s.discoveryState ?? null,
    error: s.error ?? null,
    advanceJobId: s.advanceJobId ?? null,
    advanceSkipped: s.advanceSkipped ?? null,
    printerId: s.printerId ?? null,
    printerName: s.printerName ?? null,
  };
}

function toRunDto(row: PqPrintRun): PqPrintRunDto {
  const summary = readSummary(row);
  const interrupted =
    summary.interrupted === true ||
    (row.status === "running" && !isRunActive(row.id));
  return {
    id: row.id,
    trigger: row.trigger,
    dryRun: row.dryRun,
    status: interrupted ? "interrupted" : row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    counts: summary.counts,
    discoveryMessage: summary.discoveryMessage ?? null,
    discoveryState: summary.discoveryState ?? null,
    error: summary.error ?? null,
    advanceJobId: summary.advanceJobId ?? null,
    advanceSkipped: summary.advanceSkipped ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toJobDto(row: PqPrintJob): PqPrintJobDto {
  return {
    reason: row.reason,
    priorJobId: row.priorJobId,
    priorPrintedAt: row.priorPrintedAt?.toISOString() ?? null,
    contentFingerprint: row.contentFingerprint,
    eligibilityCycle: row.eligibilityCycle,
    hubPoId: row.hubPoId,
    hubPoNumber: row.hubPoNumber,
    snapshotMetadata: row.snapshotMetadata,
    id: row.id,
    runId: row.runId,
    orderId: row.printavoOrderId,
    visualId: row.visualId != null ? Number(row.visualId) : null,
    nickname: row.nickname,
    docType: row.docType,
    sourceStatusId: row.sourceStatusId,
    sourceStatusName: row.sourceStatusName,
    targetStatusId: row.targetStatusId,
    targetStatusName: row.targetStatusName,
    printnodeJobId: row.printnodeJobId,
    printerName: row.printerName,
    copies: row.copies,
    status: row.status,
    errorMessage: row.errorMessage,
    isReprint: row.isReprint,
    printedAt: row.printedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function persistSummary(
  id: string,
  patch: Partial<PqPrintRun> & { summary: RunSummary },
): Promise<void> {
  await db
    .update(pqPrintRunsTable)
    .set({
      ...patch,
      summary: patch.summary as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(pqPrintRunsTable.id, id));
}

/** Mark DB-"running" runs not claimed in this process as interrupted. */
async function sweepInterruptedRuns(): Promise<void> {
  const rows = await db
    .select()
    .from(pqPrintRunsTable)
    .orderBy(desc(pqPrintRunsTable.createdAt))
    .limit(20);
  for (const row of rows) {
    if (row.status !== "running" || isRunActive(row.id)) continue;
    const summary = readSummary(row);
    await persistSummary(row.id, {
      status: "failed",
      finishedAt: row.finishedAt ?? new Date(),
      summary: { ...summary, interrupted: true },
    });
  }
}

/* ── Start / run ─────────────────────────────────────────────────────── */

export type StartAutoPrintResult =
  | { status: "started"; run: PqPrintRunDto }
  | { status: "conflict" }
  | { status: "invalid"; message: string };

export async function startAutoPrintRun(
  trigger: "scheduled" | "manual",
  opts: { dryRun?: boolean },
  log: Logger,
): Promise<StartAutoPrintResult> {
  if (activeRunId) return { status: "conflict" };

  const config = await getAutoPrintConfig();
  const dryRun = opts.dryRun ?? config.dryRun;

  if (config.sourceStatusIds.length === 0) {
    return { status: "invalid", message: "No source statuses configured" };
  }
  if (!dryRun && !config.printerId) {
    return { status: "invalid", message: "No printer configured" };
  }
  if (!dryRun && !printNodeConfigured()) {
    return { status: "invalid", message: "PrintNode API key is not configured" };
  }

  await sweepInterruptedRuns();

  const summary: RunSummary = {
    counts: { ...EMPTY_COUNTS },
    dryRun,
    printerId: config.printerId,
    printerName: config.printerName,
  };
  const [row] = await db
    .insert(pqPrintRunsTable)
    .values({
      trigger,
      dryRun,
      status: "running",
      startedAt: new Date(),
      summary: summary as unknown as Record<string, unknown>,
    })
    .returning();

  // Claim re-check and the claim itself stay in one synchronous block.
  if (activeRunId) {
    await persistSummary(row.id, {
      status: "failed",
      finishedAt: new Date(),
      summary: { ...summary, error: "Another run started first" },
    });
    return { status: "conflict" };
  }
  activeRunId = row.id;

  void runAutoPrint(row.id, config, dryRun, summary, log).catch(async (err) => {
    log.error({ err, runId: row.id }, "Auto-print run crashed");
    try {
      await persistSummary(row.id, {
        status: "failed",
        finishedAt: new Date(),
        summary: {
          ...summary,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      if (activeRunId === row.id) activeRunId = null;
    }
  });

  return { status: "started", run: toRunDto({ ...row }) };
}

interface Candidate {
  contentFingerprint: string;
  eligibilityCycle: string;
  priorJobId: string | null;
  priorPrintedAt: Date | null;
  isReprint: boolean;
  orderId: string;
  orderKind: "invoice" | "quote";
  visualId: number;
  nickname: string | null;
  statusId: string | null;
  statusName: string | null;
  workorderUrl: string | null;
  detailSyncedAt: Date | null;
  customerDueAt: Date | null;
  targetStatusId: string | null;
  targetStatusName: string | null;
}

type OutcomeCandidate = Pick<Candidate, "orderId" | "orderKind" | "visualId" | "statusId" | "targetStatusId">;

async function runAutoPrint(
  runId: string,
  config: AutoPrintConfig,
  dryRun: boolean,
  summary: RunSummary,
  log: Logger,
): Promise<void> {
  const counts = summary.counts;
  try {
    // Replacement-only POs never produce workorder candidates. Process the
    // prospective submission queue independently, without Printavo mutations.
    if (config.enabled && !dryRun && process.env.NODE_ENV === "production") {
      let slipRenderer: PdfRenderer | null = null;
      try {
        const slips = await runReplacementSlipBatch({
          runId, printerId: config.printerId, printerName: config.printerName,
          dryRun, production: true,
        }, {
          claim: claimReplacementSlips,
          update: async (id, patch) => {
            const rows = await db.update(pqPrintJobsTable).set(patch)
              .where(eq(pqPrintJobsTable.id, id)).returning({ id: pqPrintJobsTable.id });
            if (rows.length !== 1) throw new Error("Replacement slip reservation disappeared");
          },
          render: async html => {
            slipRenderer ??= await openPdfRenderer({ maxStartupAttempts: 1 });
            return slipRenderer.renderHtml(html);
          },
          submit: submitPdfPrintJob,
        });
        counts.printed += slips.printed;
        counts.failed += slips.failed;
        counts.candidates += slips.printed + slips.failed;
        if (slips.warnings.length) summary.error = slips.warnings.join("; ");
        await persistSummary(runId, { summary: { ...summary, counts } });
      } finally {
        const renderer = slipRenderer as PdfRenderer | null;
        await renderer?.close();
      }
    }
    /*
     * 1 — discover candidates from live Printavo before consulting the
     * mirror. The status-scoped query is paginated without an age or visual
     * cutoff, so an older invoice that just moved into a source status is
     * visible even when the normal sync window has aged it out. Discovery
     * failures abort before rendering, PrintNode, or status advance.
     */
    summary.discoveryMessage = "Checking live Printavo source statuses; candidate freshness is not yet verified.";
    summary.discoveryState = "checking";
    await persistSummary(runId, { summary });
    const live = await discoverLiveAutoPrintOrders(config.sourceStatusIds);
    summary.discoveryState = "complete";
    counts.candidates = live.orders.length;
    summary.discoveryMessage = `Live status discovery completed at ${new Date().toISOString()}: ${live.orders.length} matching orders across ${live.pages.invoices} invoice and ${live.pages.quotes} quote pages. No invoice-age cutoff. Status is checked again before printing.`;
    await persistSummary(runId, { summary });
    log.info(
      { runId, pages: live.pages, discovered: live.orders.length },
      "Auto-print live candidate discovery completed",
    );

    const liveIds = live.orders.map((order) => order.node.id);
    const visuals = live.orders.map((order) => String(order.node.visualId));

    /*
     * 2 — load print/attempt history and bound detail work. Previously printed
     * orders must still be evaluated for source reentry AND changed products.
     * Quote→invoice conversion retains its logical visual identity.
     */
    const printedRows = liveIds.length
      ? await db
          .select()
          .from(pqPrintJobsTable)
          .where(
            and(
              eq(pqPrintJobsTable.docType, "workorder"),
              or(
                inArray(pqPrintJobsTable.printavoOrderId, liveIds),
                inArray(pqPrintJobsTable.visualId, visuals),
              ),
            ),
          ).orderBy(desc(sql`coalesce(${pqPrintJobsTable.printedAt}, ${pqPrintJobsTable.createdAt})`), desc(pqPrintJobsTable.id))
      : [];
    const priorFor = (id: string, visual: number) => printedRows.find((r) =>
      r.status === "printed" && (r.printavoOrderId === id || r.visualId === String(visual))) ?? null;
    // Preparation and delivery share one budget. Successful read phases do not
    // begin a new attempt; their preceding failures carry into delivery.
    const preparationAudits = new Map<string, WorkorderRetryAudit>();
    const skip = async (order: { id: string; visualId: number; nickname?: string | null; status?: { id: string; name: string | null } | null }, reason: string) => {
      const prior = priorFor(order.id, order.visualId);
      const preparation = preparationAudits.get(order.id);
      const autoRetry = preparation ? {
        ...preparation,
        outcome: "skipped",
        attempts: preparation.attempts.map((item, index) => index === preparation.attempts.length - 1
          ? { ...item, outcome: "skipped", error: reason, delayMs: 0 } : item),
      } : undefined;
      await db.insert(pqPrintJobsTable).values({
        runId, printavoOrderId: order.id, visualId: String(order.visualId), nickname: order.nickname,
        sourceStatusId: order.status?.id, sourceStatusName: order.status?.name,
        docType: "workorder", status: "skipped", reason, priorJobId: prior?.id,
        priorPrintedAt: prior?.printedAt, copies: config.copies,
        ...(autoRetry ? { snapshotMetadata: { autoRetry } } : {}),
      });
      counts.skipped++;
      if (prior) counts.alreadyPrinted++;
    };
    // Rotate bounded detail work by last observation so unchanged older orders
    // cannot permanently starve new/reentered invoices beyond the cap.
    const lastAttempt = (id: string, visual: number) => Math.max(0, ...printedRows
      .filter((r) => r.printavoOrderId === id || r.visualId === String(visual))
      .map((r) => r.createdAt.getTime()));
    const prioritized = [...live.orders].sort((a, b) =>
      lastAttempt(a.node.id, a.node.visualId) - lastAttempt(b.node.id, b.node.visualId));
    const { selected: selectedLiveOrders, excluded, deferred } = selectAutoPrintWorkorders(
      prioritized, MAX_ORDERS_PER_RUN, (order) => order.node.visualId,
    );
    for (const order of excluded) {
      await skip(order.node, INTERNAL_REPLACEMENT_WORKORDER_SKIP_REASON);
    }
    for (const order of deferred) {
      counts.deferred++;
      await skip(order.node, "run_limit_deferred");
    }

    /*
     * 3 — mirror list fields for every live order, but force-refresh detail
     * only for the bounded evaluation list. These are local mirror
     * writes only (also allowed by the existing dry-run contract); no Printavo
     * mutation is used here.
     */
    for (const liveOrder of live.orders) {
      await upsertOrder(
        liveOrder.node,
        liveOrder.kind === "invoices" ? "invoice" : "quote",
        { emitEvents: true, syncRunId: null },
      );
    }
    const detailAgg = newDetailAgg();
    const freshDetails = new Map<string, PvOrderDetailNode>();
    const printOutcomes: {
      candidate: OutcomeCandidate;
      outcome: "printed" | "failed" | "dry_run";
      definitivePreSubmitFailure?: boolean;
    }[] = [];
    const recordPreparationFailure = async (
      liveOrder: (typeof selectedLiveOrders)[number],
      result: Awaited<ReturnType<typeof runWorkorderAttempts>>,
    ) => {
      preparationAudits.set(liveOrder.node.id, result.audit);
      if (result.outcome === "skipped") {
        await skip(liveOrder.node, (result.error as Error).message);
        return;
      }
      const last = result.audit.attempts.at(-1);
      if (!dryRun && last && retryablePreSubmission(result.error, last.phase)) {
        const prior = priorFor(liveOrder.node.id, liveOrder.node.visualId);
        const queued = await enqueuePrint({
          runId, printavoOrderId: liveOrder.node.id, visualId: String(liveOrder.node.visualId),
          nickname: liveOrder.node.nickname, docType: "workorder",
          sourceStatusId: liveOrder.node.status?.id, sourceStatusName: liveOrder.node.status?.name,
          printerId: config.printerId, printerName: config.printerName, copies: config.copies,
          priorJobId: prior?.id, priorPrintedAt: prior?.printedAt, status: "retry_pending",
          errorMessage: String(result.error), retryCount: 1, retryPhase: last.phase,
        }, { orderKind: liveOrder.kind === "invoices" ? "invoice" : "quote",
          delaysMinutes: config.retryDelaysMinutes, errorStatusId: config.errorStatusId });
        if (queued?.status === "exhausted") {
          counts.failed++;
          await finalizePrintAttempt(queued, log);
        } else if (queued) counts.pending++; else counts.skipped++;
        return;
      }
      counts.failed++;
      const prior = priorFor(liveOrder.node.id, liveOrder.node.visualId);
      await db.insert(pqPrintJobsTable).values({
        runId, printavoOrderId: liveOrder.node.id, visualId: String(liveOrder.node.visualId),
        nickname: liveOrder.node.nickname, docType: "workorder", status: "failed",
        sourceStatusId: liveOrder.node.status?.id, sourceStatusName: liveOrder.node.status?.name,
        printerId: config.printerId, printerName: config.printerName, copies: config.copies,
        priorJobId: prior?.id, priorPrintedAt: prior?.printedAt,
        errorMessage: result.error instanceof Error ? result.error.message : String(result.error),
        snapshotMetadata: { autoRetry: result.audit },
      });
      printOutcomes.push({
        candidate: {
          orderId: liveOrder.node.id, visualId: liveOrder.node.visualId,
          orderKind: liveOrder.kind === "invoices" ? "invoice" : "quote",
          statusId: liveOrder.node.status?.id ?? null, targetStatusId: null,
        },
        outcome: "failed",
        // Discovery is not proof that a previous print is safely resolved.
        // Do not move uncertain/prior deliveries to the error status because a
        // preparatory read happened to fail before eligibility was evaluated.
        definitivePreSubmitFailure: result.definitivePreSubmitFailure && !printedRows.some((job) =>
          (job.printavoOrderId === liveOrder.node.id || job.visualId === String(liveOrder.node.visualId)) &&
          ["printed", "pending", "submission_unknown"].includes(job.status)),
      });
    };
    for (const liveOrder of selectedLiveOrders) {
      const result = await runWorkorderAttempts(async (attempt) => {
        attempt.stage("live_detail");
        const fetchedAt = new Date();
        const data = await getPrintavoClient().query<SingleOrderDetail>(singleOrderDetailQuery(
          liveOrder.kind === "invoices" ? "invoice" : "quote", liveOrder.node.id,
        ));
        const node = data.invoice ?? data.quote;
        if (!node || node.id !== liveOrder.node.id || Number(node.visualId) !== liveOrder.node.visualId ||
          node.lineItemGroups.pageInfo.hasNextPage ||
          node.lineItemGroups.nodes.some((g) => g.lineItems.pageInfo.hasNextPage)) {
          counts.detailPending++;
          throw new WorkorderSkip("live_detail_missing_or_incomplete");
        }
        attempt.stage("persistence");
        const outcome = await applyOrderDetail(node, liveOrder.kind, detailAgg, log, { force: true, syncRunId: null, fetchedAt });
        if (outcome !== "written" && outcome !== "unchanged") {
          throw new WorkorderSkip(`live_detail_${outcome}`);
        }
        freshDetails.set(node.id, node);
        return "prepared";
      }, { maxAttempts: dryRun ? undefined : 1 });
      if (result.outcome === "prepared") {
        preparationAudits.set(liveOrder.node.id, result.audit);
      } else {
        if (result.outcome !== "skipped") counts.detailPending++;
        await recordPreparationFailure(liveOrder, result);
      }
    }

    /*
     * 4 — read only the bounded discovered ids from the mirror. A stale local
     * order that disappeared from the live status-scoped result can never
     * become a candidate, and no local status query is used as a fallback.
     */
    const ids = [...freshDetails.keys()];
    const mirroredRows = ids.length
      ? await db
          .select({
            printavoId: pvOrdersTable.printavoId,
            visualId: pvOrdersTable.visualId,
            nickname: pvOrdersTable.nickname,
            statusId: pvOrdersTable.statusId,
            statusName: pvOrdersTable.statusName,
            data: pvOrdersTable.data,
            detailSyncedAt: pvOrdersTable.detailSyncedAt,
            orderType: pvOrdersTable.orderType,
            customerDueAt: pvOrdersTable.customerDueAt,
          })
          .from(pvOrdersTable)
          .where(inArray(pvOrdersTable.printavoId, ids))
      : [];
    const rowsById = new Map(mirroredRows.map((row) => [row.printavoId, row]));
    if (rowsById.size !== ids.length) {
      throw new LiveDiscoveryError(
        `Live auto-print discovery could not mirror all ${ids.length} candidate order(s)`,
        "request",
      );
    }
    const sourceStatusIds = new Set(config.sourceStatusIds);
    const orderRows = ids.map((id) => rowsById.get(id)!);
    const events = ids.length ? await db.select().from(changeEventsTable).where(and(
      eq(changeEventsTable.entityType, "order"),
      eq(changeEventsTable.field, "status"),
      eq(changeEventsTable.eventType, "status_change"),
      or(inArray(changeEventsTable.entityId, ids), inArray(changeEventsTable.visualId, live.orders.map((o) => o.node.visualId))),
    )).orderBy(desc(changeEventsTable.occurredAt), desc(changeEventsTable.id)) : [];
    // Legacy observations use names; newer/wrapped shapes may carry ids.
    // Unknown or ambiguous observations never establish source reentry.
    const allStatuses = await db.select().from(pvStatusesTable);
    const configuredStatuses = allStatuses.filter((s) => sourceStatusIds.has(s.printavoId));
    const knownSourceIds = new Set([...configuredStatuses.map((s) => s.printavoId),
      ...live.orders.filter((o) => o.node.status?.name).map((o) => o.node.status!.id)]);
    const recordedStatuses = [...allStatuses.map((s) => ({ id: s.printavoId, name: s.name })),
      ...live.orders.filter((o) => o.node.status?.name).map((o) => ({ id: o.node.status!.id, name: o.node.status!.name! }))];
    const conversions = ids.length ? await db.select().from(changeEventsTable).where(and(
      eq(changeEventsTable.entityType, "order"), eq(changeEventsTable.eventType, "converted"),
      inArray(changeEventsTable.entityId, ids),
    )) : [];

    /* 5 — decoration destination configuration */
    const mappings = config.categoryMappings.map((m) => ({
      category: m.category,
      statusId: m.statusId,
      statusName: m.statusName,
    }));

    /* 6 — build the work list */
    const todo: Candidate[] = [];
    for (const row of orderRows) {
      const detail = freshDetails.get(row.printavoId)!;
      const liveOrder = selectedLiveOrders.find((o) => o.node.id === row.printavoId)!;
      const statusPreparation = await runWorkorderAttempts(async (attempt) => {
        attempt.stage("verification");
        const current = await fetchLiveOrderStatus(row.orderType === "invoice" ? "invoice" : "quote", row.printavoId);
        if (!current?.statusId || !sourceStatusIds.has(current.statusId) ||
          current.orderId !== row.printavoId || current.visualId !== row.visualId) {
          throw new WorkorderSkip("no_longer_in_source_status");
        }
        row.statusId = current.statusId;
        row.statusName = current.statusName;
        return "prepared";
      }, { previousAttempts: preparationAudits.get(row.printavoId)?.attempts.slice(0, -1), maxAttempts: dryRun ? undefined : 1 });
      preparationAudits.set(row.printavoId, statusPreparation.audit);
      if (statusPreparation.outcome !== "prepared") {
        await recordPreparationFailure(liveOrder, statusPreparation);
        continue;
      }
      const prior = priorFor(row.printavoId, row.visualId);
      const convertedFrom = verifiedConversionOrderIds({ orderId: row.printavoId, visualId: row.visualId }, conversions);
      if (prior && prior.printavoOrderId !== row.printavoId && !convertedFrom.includes(prior.printavoOrderId)) {
        await skip(liveOrder.node, "prior_visual_identity_unverified");
        continue;
      }
      if (prior && config.sourceStatusIds.some((id) => !knownSourceIds.has(id))) {
        await skip(liveOrder.node, "source_status_history_unverifiable");
        continue;
      }
      if (printedRows.some((r) => (r.printavoOrderId === row.printavoId || r.visualId === String(row.visualId)) &&
        RETRY_BLOCKING_STATES.includes(r.status))) {
        await skip(liveOrder.node, "prior_submission_unresolved");
        continue;
      }
      const fingerprint = lineItemFingerprint(detail.lineItemGroups.nodes.flatMap((g) =>
        g.lineItems.nodes.map((line) => ({ ...line }))));
      const reentry = events.find((e) => (e.entityId === row.printavoId ||
        (e.visualId === row.visualId && convertedFrom.includes(e.entityId))) &&
        observedSourceMembership(e.oldValue, recordedStatuses, sourceStatusIds) === false &&
        observedSourceMembership(e.newValue, recordedStatuses, sourceStatusIds) === true) ?? null;
      const decision = decideReprint({ prior, fingerprint, reentry });
      if (!decision.allowed) {
        await skip(liveOrder.node, decision.reason!);
        continue;
      }
      // Use the same authoritative response as the fingerprint, not mutable
      // mirror rows which another sync could replace during this run.
      const freshLines = detail.lineItemGroups.nodes.flatMap((g) => g.lineItems.nodes);
      const classification = classifyDecorationLines(freshLines.map((line) => ({
        categoryName: line.category?.name ?? null, items: line.items,
      })), {
        positiveQuantityOnly: true,
      });
      let target: { statusId: string; statusName: string } | null = null;
      if (config.routingMode === "conditional") {
        const matched = conditionalAutoPrintDestination(config.routingRules, {
          classification,
          businessDaysOut: row.customerDueAt
            ? businessDaysUntilDue(new Date(), row.customerDueAt)
            : null,
          nickname: row.nickname,
        });
        if (matched) {
          target = { statusId: matched.statusId, statusName: matched.statusName };
        }
      } else {
        const mapping = destinationMappingForClassification(classification, mappings);
        if (mapping) {
          target = { statusId: mapping.statusId, statusName: mapping.statusName };
        }
      }
      const raw = row.data as { workorderUrl?: unknown } | null;
      todo.push({
        contentFingerprint: fingerprint,
        eligibilityCycle: decision.cycle,
        priorJobId: prior?.id ?? null,
        priorPrintedAt: prior?.printedAt ?? null,
        isReprint: decision.isReprint,
        orderId: row.printavoId,
        orderKind: row.orderType === "invoice" ? "invoice" : "quote",
        visualId: row.visualId,
        nickname: row.nickname,
        statusId: row.statusId,
        statusName: row.statusName,
        workorderUrl:
          typeof raw?.workorderUrl === "string" ? raw.workorderUrl : null,
        detailSyncedAt: row.detailSyncedAt,
        customerDueAt: row.customerDueAt,
        targetStatusId: target?.statusId ?? null,
        targetStatusName: target?.statusName ?? null,
      });
    }
    await persistSummary(runId, { summary: { ...summary, counts } });

    /* 7 — render + print, one order at a time, persist after each */
    if (todo.length > 0) {
      let renderer: PdfRenderer | null = null;
      try {
          let first = true;
          for (const c of todo) {
            if (!first) await sleep(INTER_ORDER_DELAY_MS);
            first = false;
            const base = {
              runId,
              printavoOrderId: c.orderId,
              visualId: String(c.visualId),
              nickname: c.nickname,
              docType: "workorder",
              sourceStatusId: c.statusId,
              sourceStatusName: c.statusName,
              targetStatusId: c.targetStatusId,
              targetStatusName: c.targetStatusName,
              printerId: config.printerId,
              printerName: config.printerName,
              copies: config.copies,
              isReprint: c.isReprint,
              priorJobId: c.priorJobId,
              priorPrintedAt: c.priorPrintedAt,
              eligibilityCycle: c.eligibilityCycle,
            };
            if (!dryRun) {
              const queued = await enqueuePrint({ ...base, status: "retry_pending",
                contentFingerprint: c.contentFingerprint,
                attemptKey: printAttemptKey(`visual:${c.visualId}`, c.eligibilityCycle, c.contentFingerprint),
              }, { orderKind: c.orderKind, workorderUrl: c.workorderUrl, fingerprint: c.contentFingerprint,
                delaysMinutes: config.retryDelaysMinutes, errorStatusId: config.errorStatusId });
              if (!queued) { counts.skipped++; continue; }
              const result = await executePrintAttempt(queued.id, "run");
              if (result) await finalizePrintAttempt(result, log);
              if (result?.status === "printed") { counts.printed++; if (c.isReprint) counts.reprinted++; }
              else if (result?.status === "exhausted") counts.failed++;
              else counts.pending++;
              await persistSummary(runId, { summary: { ...summary, counts } });
              continue;
            }
            let reservedId: string | null = null;
            let acceptedJobId: number | null = null;
            const result = await runWorkorderAttempts(async (attempt) => {
              if (!c.workorderUrl) {
                throw new Error("No workorder URL on this order");
              }
              if (isInternalReplacementInvoice(c.visualId)) {
                throw new WorkorderSkip(INTERNAL_REPLACEMENT_WORKORDER_SKIP_REASON);
              }
              if (!dryRun && (!config.printerId || !Number.isSafeInteger(Number(config.printerId)) ||
                Number(config.printerId) <= 0 || !printNodeConfigured())) {
                throw new Error("Valid printer and PrintNode API key must be configured");
              }
              attempt.stage("renderer_startup");
              // The outer workorder budget owns recovery: do not nest three
              // browser launches inside each of the three workorder attempts.
              renderer ??= await openPdfRenderer({ maxStartupAttempts: 1 });
              attempt.stage("render");
              const pdf = await renderer.renderUrl(c.workorderUrl, {
                purchaseNotes: await loadPurchaseNotes(c.orderId),
                excludeAttachments: config.excludeAttachments,
                isReprint: c.isReprint,
                nickname: c.nickname,
              });
              if (dryRun) {
                return "dry_run";
              } else {
                if (!c.statusId) {
                  throw new Error(
                    "Source status is missing; PrintNode submission refused",
                  );
                }
                attempt.stage("verification");
                const observedStatus = await fetchLiveOrderStatus(
                  c.orderKind,
                  c.orderId,
                );
                const safety = checkPrintSafety({
                  dryRun,
                  observedStatus,
                  expected: {
                    orderId: c.orderId,
                    visualId: c.visualId,
                    sourceStatusId: c.statusId,
                  },
                });
                if (!safety.allowed) {
                  throw new WorkorderSkip(
                    safety.reason ?? "Live print safety check failed",
                  );
                }
                const verification = await getPrintavoClient().query<SingleOrderDetail>(
                  singleOrderDetailQuery(c.orderKind, c.orderId),
                );
                const verified = verification.invoice ?? verification.quote;
                if (!verified || verified.id !== c.orderId || Number(verified.visualId) !== c.visualId ||
                  verified.lineItemGroups.pageInfo.hasNextPage ||
                  verified.lineItemGroups.nodes.some((g) => g.lineItems.pageInfo.hasNextPage) ||
                  lineItemFingerprint(verified.lineItemGroups.nodes.flatMap((g) => g.lineItems.nodes.map((l) => ({ ...l })))) !== c.contentFingerprint) {
                  throw new WorkorderSkip("line_items_changed_during_render_or_detail_unavailable");
                }
                const finalSafetyStatus = await fetchLiveOrderStatus(c.orderKind, c.orderId);
                const finalSafety = checkPrintSafety({
                  dryRun,
                  observedStatus: finalSafetyStatus,
                  expected: { orderId: c.orderId, visualId: c.visualId, sourceStatusId: c.statusId },
                });
                if (!finalSafety.allowed) {
                  throw new WorkorderSkip(
                    isInternalReplacementInvoice(c.visualId) || isInternalReplacementInvoice(finalSafetyStatus?.visualId)
                      ? INTERNAL_REPLACEMENT_WORKORDER_SKIP_REASON
                      : "live_source_status_changed_after_render");
                }
                // Serialize logical-order claims across processes. The durable claim is
                // committed BEFORE the irreversible network call; ambiguity never retries.
                attempt.stage("reservation");
                // A known pre-send failure retains its durable pending claim.
                // Only this in-memory operation may reuse it; other runs still
                // see pending and cannot reserve, including after a restart.
                if (!reservedId) {
                  const claim = await db.transaction(async (tx) => {
                  const logical = `visual:${c.visualId}`;
                  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${logical}, 0))`);
                  const history = await tx.select().from(pqPrintJobsTable).where(and(
                    eq(pqPrintJobsTable.docType, "workorder"),
                    or(eq(pqPrintJobsTable.printavoOrderId, c.orderId), eq(pqPrintJobsTable.visualId, String(c.visualId))),
                    inArray(pqPrintJobsTable.status, ["pending", "submission_unknown", "printed"]),
                  )).orderBy(desc(sql`coalesce(${pqPrintJobsTable.printedAt}, ${pqPrintJobsTable.createdAt})`), desc(pqPrintJobsTable.id));
                  if (!canReservePrint(history, c.priorJobId)) return null;
                  const [reserved] = await tx.insert(pqPrintJobsTable).values({
                    ...base, status: "pending",
                    attemptKey: printAttemptKey(logical, c.eligibilityCycle, c.contentFingerprint),
                  }).onConflictDoNothing().returning();
                  return reserved ?? null;
                  });
                  if (!claim) {
                    throw new WorkorderSkip("concurrent_or_previously_reserved_attempt");
                  }
                  reservedId = claim.id;
                }
                // Last gate at the irreversible delivery boundary, including manual
                // runs and any future retry using this engine.
                attempt.stage("verification");
                const submissionSafety = checkPrintSafety({
                  dryRun,
                  observedStatus: await fetchLiveOrderStatus(c.orderKind, c.orderId),
                  expected: { orderId: c.orderId, visualId: c.visualId, sourceStatusId: c.statusId },
                });
                if (!submissionSafety.allowed) throw new WorkorderSkip(submissionSafety.reason ?? "AutoPrint submission refused");
                attempt.markSubmission();
                const jobId = await submitPdfPrintJob({
                  printerId: Number(config.printerId),
                  title: `${c.isReprint ? "UPDATED / REPRINT — " : ""}Workorder #${c.visualId}${c.nickname ? ` — ${c.nickname}` : ""}`,
                  pdfBase64: pdf.toString("base64"),
                  copies: config.copies,
                  source: "Printavo Hub auto-print",
                });
                if (!Number.isSafeInteger(jobId) || jobId <= 0) {
                  throw new Error("PrintNode returned no valid job id; submission requires manual reconciliation");
                }
                acceptedJobId = jobId;
                attempt.stage("persistence");
                await db.update(pqPrintJobsTable).set({
                  status: "printed",
                  printnodeJobId: String(jobId),
                  printedAt: new Date(),
                  contentFingerprint: c.contentFingerprint,
                }).where(eq(pqPrintJobsTable.id, reservedId));
                return "printed";
              }
            }, {
              previousAttempts: preparationAudits.get(c.orderId)?.attempts.slice(0, -1),
              onRetry: async (audit) => {
                if (reservedId) {
                  await db.update(pqPrintJobsTable).set({
                    snapshotMetadata: { autoRetry: audit },
                  }).where(eq(pqPrintJobsTable.id, reservedId));
                }
                // A crashed renderer must not poison the next attempt.
                if (renderer) await renderer.close().catch(() => undefined);
                renderer = null;
                log.warn({ runId, orderId: c.orderId, attempt: audit.attemptCount }, "Auto-print: retrying safe pre-submission failure");
              },
            });
            const terminal = {
              status: result.outcome,
              snapshotMetadata: { autoRetry: result.audit },
              errorMessage: result.error instanceof Error ? result.error.message : result.error == null ? null : String(result.error),
              reason: result.outcome === "submission_unknown" ? "submission_outcome_unknown_manual_reconciliation_required"
                : result.outcome === "skipped" ? String((result.error as Error).message) : null,
              // A failed/skipped *known pre-send* reservation may be released
              // only after the operation is terminal. Unknown sends retain it.
              ...(result.outcome === "failed" || result.outcome === "skipped" ? { attemptKey: null } : {}),
              ...(acceptedJobId ? { printnodeJobId: String(acceptedJobId) } : {}),
            };
            if (reservedId) await db.update(pqPrintJobsTable).set(terminal).where(eq(pqPrintJobsTable.id, reservedId));
            else await db.insert(pqPrintJobsTable).values({ ...base, ...terminal });
            if (result.outcome === "printed") {
              counts.printed++;
              if (c.isReprint) counts.reprinted++;
              printOutcomes.push({ candidate: c, outcome: "printed" });
            } else if (result.outcome === "dry_run") {
              counts.dryRun++;
              printOutcomes.push({ candidate: c, outcome: "dry_run" });
            } else if (result.outcome === "skipped") {
              counts.skipped++;
              if (c.priorJobId) counts.alreadyPrinted++;
            } else {
              counts.failed++;
              printOutcomes.push({ candidate: c, outcome: "failed", definitivePreSubmitFailure: result.definitivePreSubmitFailure });
              log.warn({ err: result.error, runId, orderId: c.orderId, attempts: result.audit.attemptCount }, "Auto-print: order failed");
            }
            await persistSummary(runId, { summary: { ...summary, counts } });
          }
          // Saved Hub PO snapshots only, once per run, and only for successfully
          // submitted workorders. PO errors never change workorder outcomes.
          if (!dryRun && config.printerId) {
            try {
              const po = await runHubPoBatch({
                runId,
                successfullyPrintedOrders: hubPoOrdersFromOutcomes(printOutcomes, conversions),
                printerId: config.printerId,
                printerName: config.printerName,
                dryRun,
                renderPdf: async (html) => {
                  renderer ??= await openPdfRenderer({ maxStartupAttempts: 1 });
                  return renderer.renderHtml(html);
                },
              });
              counts.poPrinted += po.printed;
              counts.poFailed += po.failed + po.unknown;
              if (po.warnings.length) summary.error = `Workorders completed; Hub PO warning: ${po.warnings.join("; ")}`;
            } catch (error) {
              counts.poFailed++;
              summary.error = `Workorders completed; Hub PO batch failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
      } finally {
        // Assigned inside attempt callbacks; TS cannot narrow that assignment.
        const remainingRenderer = renderer as PdfRenderer | null;
        if (remainingRenderer) await remainingRenderer.close().catch(() => undefined);
      }
    }

    /* 8 — post-print status advance via the ONE Printavo write path */
    if (!dryRun) {
      const lines: PqJobLineInput[] = [];
      const advanceGuardFailures: string[] = [];
      const appendGuardedLine = async (
        c: OutcomeCandidate,
        targetStatusId: string,
      ): Promise<void> => {
        if (!c.statusId || targetStatusId === c.statusId) return;
        try {
          const observedStatus = await fetchLiveOrderStatus(
            c.orderKind,
            c.orderId,
          );
          const safety = checkPrintSafety({
            dryRun: false,
            observedStatus,
            expected: {
              orderId: c.orderId,
              visualId: c.visualId,
              sourceStatusId: c.statusId,
            },
          });
          if (!safety.allowed) {
            advanceGuardFailures.push(
              `${c.orderId}: ${safety.reason ?? "live status changed"}`,
            );
            return;
          }
          lines.push({
            orderId: c.orderId,
            targetStatusId,
            expectedStatusId: c.statusId,
          });
        } catch (err) {
          advanceGuardFailures.push(
            `${c.orderId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
      for (const c of successfulPostPrintCandidates(printOutcomes)) {
        if (c.targetStatusId) await appendGuardedLine(c, c.targetStatusId);
      }
      if (config.errorStatusId) {
        for (const c of definitiveFailureCandidates(printOutcomes)) {
          await appendGuardedLine(c, config.errorStatusId);
        }
      }
      if (advanceGuardFailures.length > 0) {
        summary.advanceSkipped = `Live status guard skipped ${advanceGuardFailures.length} advance(s): ${advanceGuardFailures.join("; ")}`;
      }
      if (lines.length > 0) {
        const advance = await startPqStatusJob("autoprint", lines, log);
        if (advance.status === "started") {
          summary.advanceJobId = advance.job.id;
        } else {
          summary.advanceSkipped =
            advance.status === "conflict"
              ? "Status job slot busy — orders stay printed, move them manually"
              : advance.status === "invalid"
                ? advance.message
                : "Printavo is not configured";
        }
      }
    }

    await persistSummary(runId, {
      status: counts.pending ? "pending" : counts.failed || counts.poFailed ? "failed" : "success",
      finishedAt: new Date(),
      summary: { ...summary, counts },
    });
    if (!dryRun) await refreshRetryRun(runId);
  } catch (err) {
    if (summary.discoveryState === "checking") {
      summary.discoveryState = "failed";
      summary.discoveryMessage = "Live status discovery did not complete. Matching order count is unknown; no documents were printed.";
    }
    await persistSummary(runId, {
      status: "failed",
      finishedAt: new Date(),
      summary: {
        ...summary,
        counts,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    log.error({ err, runId }, "Auto-print run failed");
  } finally {
    if (activeRunId === runId) activeRunId = null;
  }
}

/* ── Readers ─────────────────────────────────────────────────────────── */

export async function getPrintRun(id: string): Promise<PqPrintRunDto | null> {
  const [row] = await db
    .select()
    .from(pqPrintRunsTable)
    .where(eq(pqPrintRunsTable.id, id))
    .limit(1);
  return row ? toRunDto(row) : null;
}

export async function listPrintRuns(limit: number): Promise<PqPrintRunDto[]> {
  const rows = await db
    .select()
    .from(pqPrintRunsTable)
    .orderBy(desc(pqPrintRunsTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map(toRunDto);
}

export async function listPrintJobs(opts: {
  runId?: string;
  limit: number;
  offset?: number;
}): Promise<PqPrintJobDto[]> {
  const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(Math.trunc(opts.limit), 1), 200) : 50;
  const offset = Number.isSafeInteger(opts.offset) && opts.offset! >= 0 ? opts.offset! : 0;
  const rows = opts.runId
    ? await db
        .select()
        .from(pqPrintJobsTable)
        .where(eq(pqPrintJobsTable.runId, opts.runId))
        .orderBy(desc(pqPrintJobsTable.createdAt), desc(pqPrintJobsTable.id))
        .offset(offset)
        .limit(limit)
    : await db
        .select()
        .from(pqPrintJobsTable)
        .orderBy(desc(pqPrintJobsTable.createdAt), desc(pqPrintJobsTable.id))
        .offset(offset)
        .limit(limit);
  return rows.map(toJobDto);
}

/** Most recent run start — the scheduler uses this for its due check. */
export async function lastRunStartedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: pqPrintRunsTable.startedAt })
    .from(pqPrintRunsTable)
    .orderBy(desc(pqPrintRunsTable.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

/**
 * Most recent scheduled run start. Daily mode uses the trigger-specific
 * history so a manual run cannot consume a daily slot, and the persisted
 * timestamp survives a process restart and the repeated DST hour.
 */
export async function lastScheduledRunStartedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: pqPrintRunsTable.startedAt })
    .from(pqPrintRunsTable)
    .where(eq(pqPrintRunsTable.trigger, "scheduled"))
    .orderBy(desc(pqPrintRunsTable.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}
