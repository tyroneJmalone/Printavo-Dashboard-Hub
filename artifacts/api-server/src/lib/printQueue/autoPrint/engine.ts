import type { Logger } from "pino";
import {
  db,
  pqPrintRunsTable,
  pqPrintJobsTable,
  pvOrdersTable,
  pvImprintsTable,
  type PqPrintRun,
  type PqPrintJob,
} from "@workspace/db";
import { eq, desc, inArray, and, or } from "drizzle-orm";
import { getAutoPrintConfig, type AutoPrintConfig } from "./config";
import { openPdfRenderer } from "./pdf";
import {
  printNodeConfigured,
  submitPdfPrintJob,
} from "./printNode";
import { startPqStatusJob, type PqJobLineInput } from "../statusJobs";

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
  visualId: number;
  nickname: string | null;
  statusId: string | null;
  statusName: string | null;
  workorderUrl: string | null;
  detailSyncedAt: Date | null;
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
    /* 1 — candidates from local Postgres only */
    const orderRows = await db
      .select({
        printavoId: pvOrdersTable.printavoId,
        visualId: pvOrdersTable.visualId,
        nickname: pvOrdersTable.nickname,
        statusId: pvOrdersTable.statusId,
        statusName: pvOrdersTable.statusName,
        data: pvOrdersTable.data,
        detailSyncedAt: pvOrdersTable.detailSyncedAt,
      })
      .from(pvOrdersTable)
      .where(inArray(pvOrdersTable.statusId, config.sourceStatusIds))
      .orderBy(pvOrdersTable.visualId);
    counts.candidates = orderRows.length;

    /* 2 — dedup against printed history (printavoId OR visualId — quote→
       invoice conversion mints a new printavo id for the same visual id) */
    const ids = orderRows.map((r) => r.printavoId);
    const visuals = orderRows.map((r) => String(r.visualId));
    const printedRows = ids.length
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
                inArray(pqPrintJobsTable.printavoOrderId, ids),
                inArray(pqPrintJobsTable.visualId, visuals),
              ),
            ),
          )
      : [];
    const printedIds = new Set(printedRows.map((r) => r.orderId));
    const printedVisuals = new Set(
      printedRows.map((r) => r.visualId).filter((v): v is string => v != null),
    );

    /* 3 — typeOfWork categories for mapping */
    const imprintRows = ids.length
      ? await db
          .select({
            orderId: pvImprintsTable.orderId,
            typeOfWork: pvImprintsTable.typeOfWork,
          })
          .from(pvImprintsTable)
          .where(inArray(pvImprintsTable.orderId, ids))
      : [];
    const categoriesByOrder = new Map<string, Set<string>>();
    for (const r of imprintRows) {
      if (!r.typeOfWork) continue;
      const set = categoriesByOrder.get(r.orderId) ?? new Set<string>();
      set.add(r.typeOfWork.trim().toLowerCase());
      categoriesByOrder.set(r.orderId, set);
    }
    const mappings = config.categoryMappings.map((m) => ({
      category: m.category.trim().toLowerCase(),
      statusId: m.statusId,
      statusName: m.statusName,
    }));

    /* 4 — build the work list */
    const todo: Candidate[] = [];
    for (const row of orderRows) {
      if (
        printedIds.has(row.printavoId) ||
        printedVisuals.has(String(row.visualId))
      ) {
        counts.alreadyPrinted += 1;
        continue;
      }
      const cats = categoriesByOrder.get(row.printavoId);
      if (!cats && !row.detailSyncedAt) {
        // Imprints arrive with the detail sync — defer instead of printing
        // with a silently-missed category mapping.
        counts.detailPending += 1;
        continue;
      }
      let target: { statusId: string; statusName: string } | null = null;
      if (cats) {
        for (const m of mappings) {
          if (cats.has(m.category)) {
            target = { statusId: m.statusId, statusName: m.statusName };
            break;
          }
        }
      }
      if (todo.length >= MAX_ORDERS_PER_RUN) {
        counts.deferred += 1;
        continue;
      }
      const raw = row.data as { workorderUrl?: unknown } | null;
      todo.push({
        orderId: row.printavoId,
        visualId: row.visualId,
        nickname: row.nickname,
        statusId: row.statusId,
        statusName: row.statusName,
        workorderUrl:
          typeof raw?.workorderUrl === "string" ? raw.workorderUrl : null,
        detailSyncedAt: row.detailSyncedAt,
        targetStatusId: target?.statusId ?? null,
        targetStatusName: target?.statusName ?? null,
      });
    }
    await persistSummary(runId, { summary: { ...summary, counts } });

    /* 5 — render + print, one order at a time, persist after each */
    const printedOk: Candidate[] = [];
    const failed: Candidate[] = [];
    if (todo.length > 0) {
      const renderer = await openPdfRenderer();
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
            isReprint: false,
          };
          try {
            if (!c.workorderUrl) {
              throw new Error("No workorder URL on this order");
            }
            const pdf = await renderer.renderUrl(c.workorderUrl);
            if (dryRun) {
              counts.dryRun += 1;
              await db.insert(pqPrintJobsTable).values({
                ...base,
                status: "dry_run",
              });
            } else {
              const jobId = await submitPdfPrintJob({
                printerId: Number(config.printerId),
                title: `Workorder #${c.visualId}${c.nickname ? ` — ${c.nickname}` : ""}`,
                pdfBase64: pdf.toString("base64"),
                copies: config.copies,
                source: "Printavo Hub auto-print",
              });
              counts.printed += 1;
              printedOk.push(c);
              await db.insert(pqPrintJobsTable).values({
                ...base,
                status: "printed",
                printnodeJobId: String(jobId),
                printedAt: new Date(),
              });
            }
          } catch (err) {
            counts.failed += 1;
            failed.push(c);
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
      } finally {
        await renderer.close();
      }
    }

    /* 6 — post-print status advance via the ONE Printavo write path */
    if (!dryRun) {
      const lines: PqJobLineInput[] = [];
      for (const c of printedOk) {
        if (c.targetStatusId && c.statusId && c.targetStatusId !== c.statusId) {
          lines.push({
            orderId: c.orderId,
            targetStatusId: c.targetStatusId,
            expectedStatusId: c.statusId,
          });
        }
      }
      if (config.errorStatusId) {
        for (const c of failed) {
          if (c.statusId && config.errorStatusId !== c.statusId) {
            lines.push({
              orderId: c.orderId,
              targetStatusId: config.errorStatusId,
              expectedStatusId: c.statusId,
            });
          }
        }
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
