import type { Logger } from "pino";
import {
  db,
  pqPrintRunsTable,
  pqPrintJobsTable,
  pvOrdersTable,
  pvLineItemsTable,
  type PqPrintRun,
  type PqPrintJob,
} from "@workspace/db";
import { eq, desc, inArray, and, or } from "drizzle-orm";
import { upsertOrder } from "../../sync/upserts";
import { refreshOrderDetail, newDetailAgg } from "../../sync/detail";
import { getAutoPrintConfig, type AutoPrintConfig } from "./config";
import { openPdfRenderer } from "./pdf";
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
import { checkPrintSafety } from "./printSafety";
import { planAutoPrintDetails } from "./candidatePlanning";
import {
  classifyDecorationLines,
  destinationMappingForClassification,
  type DecorationLine,
} from "../../purchasing/decorationClassifier";
import { businessDaysUntilDue } from "../../purchasing/businessDays";
import {
  conditionalAutoPrintDestination,
  successfulPostPrintCandidates,
} from "./routing";
import { withRendererStartupGuard } from "./rendererStartupGuard";

export { PDF_RENDERER_STARTUP_ERROR_PREFIX } from "./rendererStartupGuard";

/**
 * Auto-print engine (PQ3a). One run at a time (in-memory claim slot,
 * pq_status_jobs pattern). Per-order outcomes are persisted to
 * pq_print_jobs as each order finishes, so a restart can never lose track
 * of what was already sent to the printer — those rows are also the dedup
 * source ("already printed").
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
  candidates: number;
  alreadyPrinted: number;
  detailPending: number;
  deferred: number;
  printed: number;
  failed: number;
  dryRun: number;
}

interface RunSummary {
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
    error: summary.error ?? null,
    advanceJobId: summary.advanceJobId ?? null,
    advanceSkipped: summary.advanceSkipped ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toJobDto(row: PqPrintJob): PqPrintJobDto {
  return {
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

async function runAutoPrint(
  runId: string,
  config: AutoPrintConfig,
  dryRun: boolean,
  summary: RunSummary,
  log: Logger,
): Promise<void> {
  const counts = summary.counts;
  try {
    /*
     * 1 — discover candidates from live Printavo before consulting the
     * mirror. The status-scoped query is paginated without an age or visual
     * cutoff, so an older invoice that just moved into a source status is
     * visible even when the normal sync window has aged it out. Discovery
     * failures abort before rendering, PrintNode, or status advance.
     */
    const live = await discoverLiveAutoPrintOrders(config.sourceStatusIds);
    log.info(
      { runId, pages: live.pages, discovered: live.orders.length },
      "Auto-print live candidate discovery completed",
    );

    const liveIds = live.orders.map((order) => order.node.id);
    const visuals = live.orders.map((order) => String(order.node.visualId));

    /*
     * 2 — dedup against printed history and apply the run cap BEFORE detail
     * refresh. Quote→invoice conversion can mint a new id for the same visual
     * id, so both identity forms remain part of the history check.
     */
    const printedRows = liveIds.length
      ? await db
          .select({
            orderId: pqPrintJobsTable.printavoOrderId,
            visualId: pqPrintJobsTable.visualId,
          })
          .from(pqPrintJobsTable)
          .where(
            and(
              eq(pqPrintJobsTable.status, "printed"),
              eq(pqPrintJobsTable.docType, "workorder"),
              or(
                inArray(pqPrintJobsTable.printavoOrderId, liveIds),
                inArray(pqPrintJobsTable.visualId, visuals),
              ),
            ),
          )
      : [];
    const printedIds = new Set(printedRows.map((r) => r.orderId));
    const printedVisuals = new Set(
      printedRows.map((r) => r.visualId).filter((v): v is string => v != null),
    );
    const plan = planAutoPrintDetails(
      live.orders,
      (liveOrder) => ({
        orderId: liveOrder.node.id,
        visualId: liveOrder.node.visualId,
      }),
      printedIds,
      printedVisuals,
      MAX_ORDERS_PER_RUN,
    );
    counts.alreadyPrinted += plan.alreadyPrinted;
    counts.deferred += plan.deferred;
    const selectedLiveOrders = plan.selected;

    /*
     * 3 — mirror list fields for every live order, but force-refresh detail
     * only for the bounded, unprinted work list. These are local mirror
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
    for (const liveOrder of selectedLiveOrders) {
      const detailOutcome = await refreshOrderDetail(
        liveOrder.node.id,
        liveOrder.kind,
        detailAgg,
        log,
        { force: true, syncRunId: null },
      );
      if (detailOutcome !== "written" && detailOutcome !== "unchanged") {
        throw new LiveDiscoveryError(
          `Live auto-print candidate ${liveOrder.node.id} detail refresh was ${detailOutcome}; refusing to print incomplete data`,
          "request",
        );
      }
    }

    /*
     * 4 — read only the bounded discovered ids from the mirror. A stale local
     * order that disappeared from the live status-scoped result can never
     * become a candidate, and no local status query is used as a fallback.
     */
    const ids = selectedLiveOrders.map((order) => order.node.id);
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
    const orderRows = ids.map((id) => {
      const row = rowsById.get(id);
      if (!row || !row.statusId || !sourceStatusIds.has(row.statusId)) {
        throw new LiveDiscoveryError(
          `Live auto-print candidate ${id} is no longer in a configured source status after refresh`,
          "request",
        );
      }
      return row;
    });
    counts.candidates = orderRows.length;

    /* 5 — line-item decoration classification for mapping */
    const lineItemRows = ids.length
      ? await db
          .select({
            orderId: pvLineItemsTable.orderId,
            categoryName: pvLineItemsTable.categoryName,
            items: pvLineItemsTable.items,
          })
          .from(pvLineItemsTable)
          .where(inArray(pvLineItemsTable.orderId, ids))
      : [];
    const linesByOrder = new Map<string, DecorationLine[]>();
    for (const r of lineItemRows) {
      const lines = linesByOrder.get(r.orderId) ?? [];
      lines.push({ categoryName: r.categoryName, items: r.items });
      linesByOrder.set(r.orderId, lines);
    }
    const mappings = config.categoryMappings.map((m) => ({
      category: m.category,
      statusId: m.statusId,
      statusName: m.statusName,
    }));

    /* 6 — build the work list */
    const todo: Candidate[] = [];
    for (const row of orderRows) {
      const lines = linesByOrder.get(row.printavoId);
      if (!lines && !row.detailSyncedAt) {
        // Line items arrive with the detail sync — defer instead of printing
        // with a silently-missed category mapping.
        counts.detailPending += 1;
        continue;
      }
      const classification = classifyDecorationLines(lines ?? [], {
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
    const printOutcomes: {
      candidate: Candidate;
      outcome: "printed" | "failed" | "dry_run";
    }[] = [];
    if (todo.length > 0) {
      await withRendererStartupGuard(
        todo,
        openPdfRenderer,
        async (pending, errorMessage) => {
          await db.insert(pqPrintJobsTable).values(
            pending.map((c) => ({
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
              isReprint: false,
              status: "failed",
              errorMessage,
            })),
          );
          counts.failed += pending.length;
          await persistSummary(runId, {
            summary: { ...summary, counts, error: errorMessage },
          });
        },
        async (renderer, pending) => {
          let first = true;
          for (const c of pending) {
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
              isReprint: false,
            };
            try {
              if (!c.workorderUrl) {
                throw new Error("No workorder URL on this order");
              }
              const pdf = await renderer.renderUrl(c.workorderUrl, {
                excludeAttachments: config.excludeAttachments,
              });
              if (dryRun) {
                counts.dryRun += 1;
                printOutcomes.push({ candidate: c, outcome: "dry_run" });
                await db.insert(pqPrintJobsTable).values({
                  ...base,
                  status: "dry_run",
                });
              } else {
                if (!c.statusId) {
                  throw new Error(
                    "Source status is missing; PrintNode submission refused",
                  );
                }
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
                  throw new Error(
                    safety.reason ?? "Live print safety check failed",
                  );
                }
                const jobId = await submitPdfPrintJob({
                  printerId: Number(config.printerId),
                  title: `Workorder #${c.visualId}${c.nickname ? ` — ${c.nickname}` : ""}`,
                  pdfBase64: pdf.toString("base64"),
                  copies: config.copies,
                  source: "Printavo Hub auto-print",
                });
                counts.printed += 1;
                printOutcomes.push({ candidate: c, outcome: "printed" });
                await db.insert(pqPrintJobsTable).values({
                  ...base,
                  status: "printed",
                  printnodeJobId: String(jobId),
                  printedAt: new Date(),
                });
              }
            } catch (err) {
              counts.failed += 1;
              printOutcomes.push({ candidate: c, outcome: "failed" });
              await db.insert(pqPrintJobsTable).values({
                ...base,
                status: "failed",
                errorMessage: err instanceof Error ? err.message : String(err),
              });
              log.warn(
                { err, orderId: c.orderId, visualId: c.visualId },
                "Auto-print: order failed",
              );
            }
            await persistSummary(runId, { summary: { ...summary, counts } });
          }
        },
      );
    }

    /* 8 — post-print status advance via the ONE Printavo write path */
    if (!dryRun) {
      const lines: PqJobLineInput[] = [];
      const advanceGuardFailures: string[] = [];
      const appendGuardedLine = async (
        c: Candidate,
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
        for (const c of printOutcomes
          .filter((item) => item.outcome === "failed")
          .map((item) => item.candidate)) {
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
      status: "success",
      finishedAt: new Date(),
      summary: { ...summary, counts },
    });
  } catch (err) {
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
}): Promise<PqPrintJobDto[]> {
  const limit = Math.min(Math.max(opts.limit, 1), 200);
  const rows = opts.runId
    ? await db
        .select()
        .from(pqPrintJobsTable)
        .where(eq(pqPrintJobsTable.runId, opts.runId))
        .orderBy(desc(pqPrintJobsTable.createdAt))
        .limit(limit)
    : await db
        .select()
        .from(pqPrintJobsTable)
        .orderBy(desc(pqPrintJobsTable.createdAt))
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
