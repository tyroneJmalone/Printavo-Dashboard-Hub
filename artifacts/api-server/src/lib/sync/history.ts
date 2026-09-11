import type { Logger } from "pino";
import { db, pvOrdersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  invoicesPageQuery,
  quotesPageQuery,
  orderDetailPageQuery,
  orderTotalsQuery,
  PAGE_SIZE,
  DETAIL_PAGE_SIZE,
  type InvoicesPage,
  type QuotesPage,
  type InvoicesDetailPage,
  type QuotesDetailPage,
  type OrderTotals,
  type OrderKind,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import {
  isSeedActive,
  isPollActive,
  isDetailBackfillActive,
  isPaymentsSeedActive,
  isHistoryBackfillActive,
  setHistoryBackfillActive,
} from "./runState";
import {
  createRun,
  findRunningRun,
  completeRun,
  failRun,
  getOrCreateCheckpoint,
  updateCheckpointCursor,
  markCheckpointComplete,
  setWatermark,
} from "./state";
import { upsertOrder, type UpsertOpts } from "./upserts";
import { applyOrderDetail, newDetailAgg, type DetailAgg } from "./detail";
import { SEED_MONTHS } from "./seed";

export { isHistoryBackfillActive } from "./runState";

/**
 * BACKUP MODULE B2 — full-history backfill (all orders back to Feb 2018).
 *
 * Printavo's offset pagination has a HARD 10,000-ROW WINDOW (verified
 * live July 2026): totalNodes caps at 10,000, requesting an offset >=
 * 10,000 errors ("Oops! Something went wrong"), and the row-10,000
 * boundary page cleanly reports hasNextPage: false. With ~14-15k
 * invoices, no single sort direction can see them all.
 *
 * Strategy — meet in the middle:
 *   1. ASCENDING phase (sortOn: VISUAL_ID asc): walks the OLDEST 10k
 *      rows; ends naturally at the window cap. The final cursor offset
 *      tells us whether we were capped (=10,000) or hit the true end.
 *   2. DESCENDING sweep (only when capped): walks from the NEWEST row
 *      down until it reaches the ascending phase's last visual id
 *      (the cutover). VISUAL_ID sort is monotonic, so the stop rule is
 *      exact. Union of the two passes = full coverage while the total
 *      stays under 20k rows.
 *
 * Poll coexistence: unlike seed/detail/payments, the incremental poll
 * does NOT skip while this runs. The backfill YIELDS — before every
 * page request it waits for any active poll to finish, so the 5-minute
 * sync stays fresh throughout the multi-hour crawl.
 *
 * Ownership rule (architect ruling): list phases only write rows that
 * are MISSING or historical (printavo_created_at older than the seed
 * window). In-window rows stay owned by the incremental poll so no
 * change events are masked. Detail phases need no such guard —
 * applyOrderDetail is hash-guarded and never touches the list hash.
 */

const HISTORY_RUN_TYPE = "history_backfill";

/** Printavo's offset pagination window (verified live July 2026). */
const WINDOW_CAP = 10_000;

/** On resume, rewind offset-style cursors two pages (idempotent upserts
 *  make overlap free; deletions mid-crawl shift offsets backward). */
const RESUME_REWIND = PAGE_SIZE * 2;

const LIST_PHASES = [
  {
    ascEntity: "invoices_history",
    descEntity: "invoices_history_desc",
    kind: "invoices" as OrderKind,
    orderType: "invoice" as const,
  },
  {
    ascEntity: "quotes_history",
    descEntity: "quotes_history_desc",
    kind: "quotes" as OrderKind,
    orderType: "quote" as const,
  },
];

const DETAIL_PHASES = [
  {
    ascEntity: "invoices_detail_history",
    descEntity: "invoices_detail_history_desc",
    kind: "invoices" as OrderKind,
  },
  {
    ascEntity: "quotes_detail_history",
    descEntity: "quotes_detail_history_desc",
    kind: "quotes" as OrderKind,
  },
];

export interface HistoryBackfillStart {
  started: boolean;
  syncRunId: number | null;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait out any active incremental poll before the next page request. */
async function yieldToPoll(): Promise<void> {
  while (isPollActive()) {
    await sleep(5_000);
  }
}

/** Printavo cursors are base64-encoded integer offsets ("Mw" = 3). */
export function decodeOffset(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const offset = Number.parseInt(decoded, 10);
    if (!Number.isFinite(offset) || String(offset) !== decoded.trim()) return null;
    return offset;
  } catch {
    return null;
  }
}

/**
 * Rewind an offset cursor by `by` records; falls back to the original
 * cursor if the format ever changes.
 */
export function rewindCursor(cursor: string | null, by: number): string | null {
  const offset = decodeOffset(cursor);
  if (offset === null) return cursor;
  const rewound = Math.max(0, offset - by);
  if (rewound === 0) return null;
  // Printavo emits unpadded base64 — match it.
  return Buffer.from(String(rewound), "utf8")
    .toString("base64")
    .replace(/=+$/, "");
}

export async function startOrResumeHistoryBackfill(
  logger: Logger,
): Promise<HistoryBackfillStart> {
  if (isHistoryBackfillActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "A history backfill is already running",
    };
  }
  if (isSeedActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "Seed is running — try again once it finishes",
    };
  }
  if (isDetailBackfillActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "A detail backfill is running — try again once it finishes",
    };
  }
  if (isPaymentsSeedActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "A payments seed is running — try again once it finishes",
    };
  }
  if (!printavoConfigured()) {
    return {
      started: false,
      syncRunId: null,
      message: "Printavo credentials are not configured yet",
    };
  }
  setHistoryBackfillActive(true);
  let run;
  let resumed = false;
  try {
    run = await findRunningRun(HISTORY_RUN_TYPE);
    resumed = Boolean(run);
    if (!run) {
      run = await createRun(HISTORY_RUN_TYPE);
    }
  } catch (err) {
    setHistoryBackfillActive(false);
    throw err;
  }
  const runId = run.id;
  const startedAt = run.startedAt;
  void runHistoryBackfill(runId, startedAt, logger)
    .catch((err) => {
      logger.error({ err }, "History backfill crashed");
    })
    .finally(() => {
      setHistoryBackfillActive(false);
    });
  return {
    started: true,
    syncRunId: runId,
    message: resumed
      ? `Resuming interrupted history backfill run #${runId}`
      : `History backfill run #${runId} started (full archive, oldest-first)`,
  };
}

interface ListPhaseStats {
  pages: number;
  seen: number;
  written: number;
  skippedInWindow: number;
  reachedCutover?: boolean;
  coverageGap?: boolean;
}

async function runHistoryBackfill(
  runId: number,
  runStartedAt: Date,
  logger: Logger,
): Promise<void> {
  const cutoff = new Date(runStartedAt);
  cutoff.setMonth(cutoff.getMonth() - SEED_MONTHS);
  const client = getPrintavoClient();
  try {
    await yieldToPoll();
    const totals = await client.query<OrderTotals>(orderTotalsQuery());
    logger.info(
      {
        runId,
        cutoff: cutoff.toISOString(),
        invoicesTotal: totals.invoices.totalNodes,
        quotesTotal: totals.quotes.totalNodes,
        note: "totalNodes caps at 10,000",
      },
      "History backfill starting/resuming",
    );

    const listStats: Record<string, ListPhaseStats> = {};
    for (const phase of LIST_PHASES) {
      listStats[phase.ascEntity] = await historyListAsc(
        runId,
        phase.ascEntity,
        phase.kind,
        phase.orderType,
        cutoff,
        logger,
      );
      listStats[phase.descEntity] = await historyListDescSweep(
        runId,
        phase.ascEntity,
        phase.descEntity,
        phase.kind,
        phase.orderType,
        cutoff,
        logger,
      );
    }

    const detailAgg = newDetailAgg();
    for (const phase of DETAIL_PHASES) {
      await historyDetailAsc(runId, phase.ascEntity, phase.kind, logger, detailAgg);
      await historyDetailDescSweep(
        runId,
        phase.ascEntity,
        phase.descEntity,
        phase.kind,
        logger,
        detailAgg,
      );
    }

    // Verification: DB row counts vs Printavo's totals. The invoice
    // total is capped at 10k so its gap is only meaningful when the
    // reported total is below the cap.
    await yieldToPoll();
    const finalTotals = await client.query<OrderTotals>(orderTotalsQuery());
    const [invRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.orderType, "invoice"));
    const [quoRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.orderType, "quote"));
    const invCapped = finalTotals.invoices.totalNodes >= WINDOW_CAP;
    const quoCapped = finalTotals.quotes.totalNodes >= WINDOW_CAP;
    const verification = {
      invoicesExpected: finalTotals.invoices.totalNodes,
      invoicesExpectedCapped: invCapped,
      invoicesInDb: invRow?.n ?? 0,
      invoicesGap: invCapped
        ? null
        : finalTotals.invoices.totalNodes - (invRow?.n ?? 0),
      quotesExpected: finalTotals.quotes.totalNodes,
      quotesExpectedCapped: quoCapped,
      quotesInDb: quoRow?.n ?? 0,
      quotesGap: quoCapped
        ? null
        : finalTotals.quotes.totalNodes - (quoRow?.n ?? 0),
    };
    if (
      (verification.invoicesGap ?? 0) !== 0 ||
      (verification.quotesGap ?? 0) !== 0
    ) {
      logger.warn(
        { runId, verification },
        "History backfill count mismatch — a re-run is cheap and will fill gaps",
      );
    }

    await setWatermark(HISTORY_RUN_TYPE, runStartedAt);
    await completeRun(runId, {
      cutoff: cutoff.toISOString(),
      list: listStats,
      detail: detailAgg,
      verification,
    });
    logger.info(
      { runId, list: listStats, detail: detailAgg, verification },
      "History backfill completed",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message).catch(() => undefined);
    logger.error({ runId, err }, "History backfill failed");
  }
}

/** Skip rule: only write rows that are missing or historical. */
async function shouldWriteOrder(printavoId: string, cutoff: Date): Promise<boolean> {
  const [existing] = await db
    .select({ printavoCreatedAt: pvOrdersTable.printavoCreatedAt })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.printavoId, printavoId))
    .limit(1);
  if (!existing) return true;
  return (
    existing.printavoCreatedAt != null && existing.printavoCreatedAt < cutoff
  );
}

/** Oldest-first list crawl; ends at true end OR the 10k window cap. */
async function historyListAsc(
  runId: number,
  entity: string,
  kind: OrderKind,
  orderType: "invoice" | "quote",
  cutoff: Date,
  logger: Logger,
): Promise<ListPhaseStats> {
  const stats: ListPhaseStats = { pages: 0, seen: 0, written: 0, skippedInWindow: 0 };
  const checkpoint = await getOrCreateCheckpoint(runId, entity);
  if (checkpoint.completed) return stats;

  const client = getPrintavoClient();
  const opts: UpsertOpts = { emitEvents: false, syncRunId: runId };
  let cursor = rewindCursor(checkpoint.cursor ?? null, RESUME_REWIND);

  for (;;) {
    await yieldToPoll();
    const query =
      kind === "invoices"
        ? invoicesPageQuery({ after: cursor, sortDescending: false })
        : quotesPageQuery({ after: cursor, sortDescending: false });
    const data =
      kind === "invoices"
        ? (await client.query<InvoicesPage>(query)).invoices
        : (await client.query<QuotesPage>(query)).quotes;

    let lastVisualId: number | null = null;
    for (const node of data.nodes) {
      stats.seen += 1;
      const visual = Number(node.visualId);
      if (Number.isFinite(visual)) lastVisualId = visual;
      if (await shouldWriteOrder(node.id, cutoff)) {
        await upsertOrder(node, orderType, opts);
        stats.written += 1;
      } else {
        stats.skippedInWindow += 1;
      }
    }

    stats.pages += 1;
    cursor = data.pageInfo.endCursor;
    await updateCheckpointCursor(runId, entity, cursor, lastVisualId);

    if (stats.pages % 10 === 0) {
      logger.info(
        { runId, entity, ...stats, lastVisualId, offset: decodeOffset(cursor) },
        "History list progress (ascending)",
      );
    }
    if (!data.pageInfo.hasNextPage) break;
    // Never issue a request that would cross the 10k window boundary —
    // crossing requests error (page size need not divide 10,000).
    const offset = decodeOffset(cursor);
    if (offset !== null && offset + PAGE_SIZE > WINDOW_CAP) break;
  }

  await markCheckpointComplete(runId, entity);
  logger.info({ runId, entity, ...stats }, "History list ascending completed");
  return stats;
}

/**
 * Newest-first sweep for the rows the ascending pass could not reach
 * past the 10k window. Runs only when the ascending pass was capped;
 * stops once it descends to the ascending cutover visual id.
 */
async function historyListDescSweep(
  runId: number,
  ascEntity: string,
  entity: string,
  kind: OrderKind,
  orderType: "invoice" | "quote",
  cutoff: Date,
  logger: Logger,
): Promise<ListPhaseStats> {
  const stats: ListPhaseStats = { pages: 0, seen: 0, written: 0, skippedInWindow: 0 };
  const checkpoint = await getOrCreateCheckpoint(runId, entity);
  if (checkpoint.completed) return stats;

  const ascCheckpoint = await getOrCreateCheckpoint(runId, ascEntity);
  const ascFinalOffset = decodeOffset(ascCheckpoint.cursor) ?? 0;
  // Capped ⟺ the ascending pass stopped because the NEXT page would
  // cross the window (covers both aligned and unaligned page sizes).
  const capped = ascFinalOffset + PAGE_SIZE > WINDOW_CAP;
  const cutover = ascCheckpoint.lastVisualId ?? 0;
  if (!capped) {
    // Ascending saw the true end of the list — nothing left to sweep.
    await markCheckpointComplete(runId, entity);
    return stats;
  }
  logger.info(
    { runId, entity, cutover, ascFinalOffset },
    "Ascending pass hit the 10k window cap — sweeping the remainder newest-first",
  );

  const client = getPrintavoClient();
  const opts: UpsertOpts = { emitEvents: false, syncRunId: runId };
  let cursor = rewindCursor(checkpoint.cursor ?? null, RESUME_REWIND);
  let reachedCutover = false;

  for (;;) {
    await yieldToPoll();
    const query =
      kind === "invoices"
        ? invoicesPageQuery({ after: cursor })
        : quotesPageQuery({ after: cursor });
    const data =
      kind === "invoices"
        ? (await client.query<InvoicesPage>(query)).invoices
        : (await client.query<QuotesPage>(query)).quotes;

    let lastVisualId: number | null = null;
    for (const node of data.nodes) {
      const visual = Number(node.visualId);
      if (Number.isFinite(visual)) {
        lastVisualId = visual;
        // Stop strictly BELOW the cutover: visual ids may be duplicated
        // ("renumbered or reused"), so a ==cutover twin past the window
        // boundary must still be written (upserts are idempotent).
        if (visual < cutover) {
          reachedCutover = true;
          break;
        }
      }
      stats.seen += 1;
      if (await shouldWriteOrder(node.id, cutoff)) {
        await upsertOrder(node, orderType, opts);
        stats.written += 1;
      } else {
        stats.skippedInWindow += 1;
      }
    }

    stats.pages += 1;
    cursor = data.pageInfo.endCursor;
    await updateCheckpointCursor(runId, entity, cursor, lastVisualId);

    if (stats.pages % 10 === 0) {
      logger.info(
        { runId, entity, ...stats, lastVisualId, cutover },
        "History list progress (descending sweep)",
      );
    }
    if (reachedCutover || !data.pageInfo.hasNextPage) break;
    const offset = decodeOffset(cursor);
    if (offset !== null && offset + PAGE_SIZE > WINDOW_CAP) break;
  }

  stats.reachedCutover = reachedCutover;
  if (!reachedCutover) {
    // Sweep ended (window cap or unexpected list end) without meeting
    // the ascending pass — middle rows unreachable via list pagination.
    stats.coverageGap = true;
    logger.warn(
      { runId, entity, cutover },
      "Descending sweep ended WITHOUT reaching the ascending cutover — coverage gap",
    );
  }
  await markCheckpointComplete(runId, entity);
  logger.info(
    { runId, entity, ...stats },
    "History list descending sweep completed",
  );
  return stats;
}

/** Oldest-first detail crawl; hash guard makes already-synced rows cheap. */
async function historyDetailAsc(
  runId: number,
  entity: string,
  kind: OrderKind,
  logger: Logger,
  agg: DetailAgg,
): Promise<void> {
  const checkpoint = await getOrCreateCheckpoint(runId, entity);
  if (checkpoint.completed) return;

  const client = getPrintavoClient();
  let cursor = rewindCursor(checkpoint.cursor ?? null, RESUME_REWIND);
  let pages = 0;

  for (;;) {
    await yieldToPoll();
    const fetchedAt = new Date();
    const data =
      kind === "invoices"
        ? (await client.query<InvoicesDetailPage>(
            orderDetailPageQuery(kind, cursor, { sortDescending: false }),
          )).invoices
        : (await client.query<QuotesDetailPage>(
            orderDetailPageQuery(kind, cursor, { sortDescending: false }),
          )).quotes;

    let lastVisualId: number | null = null;
    for (const node of data.nodes) {
      const visual = Number(node.visualId);
      if (Number.isFinite(visual)) lastVisualId = visual;
      await applyOrderDetail(node, kind, agg, logger, {
        syncRunId: runId,
        fetchedAt,
      });
    }

    pages += 1;
    cursor = data.pageInfo.endCursor;
    await updateCheckpointCursor(runId, entity, cursor, lastVisualId);

    if (pages % 20 === 0) {
      logger.info(
        { runId, entity, pages, agg, offset: decodeOffset(cursor) },
        "History detail progress (ascending)",
      );
    }
    if (!data.pageInfo.hasNextPage) break;
    // DETAIL_PAGE_SIZE (6) does not divide 10,000 — a request from
    // offset 9,996 would cross the window boundary and error. Stop
    // proactively before any crossing request.
    const offset = decodeOffset(cursor);
    if (offset !== null && offset + DETAIL_PAGE_SIZE > WINDOW_CAP) break;
  }

  await markCheckpointComplete(runId, entity);
  logger.info({ runId, entity, pages, agg }, "History detail ascending completed");
}

/** Newest-first detail sweep past the 10k window (mirror of the list sweep). */
async function historyDetailDescSweep(
  runId: number,
  ascEntity: string,
  entity: string,
  kind: OrderKind,
  logger: Logger,
  agg: DetailAgg,
): Promise<void> {
  const checkpoint = await getOrCreateCheckpoint(runId, entity);
  if (checkpoint.completed) return;

  const ascCheckpoint = await getOrCreateCheckpoint(runId, ascEntity);
  const ascFinalOffset = decodeOffset(ascCheckpoint.cursor) ?? 0;
  // Page-size-aware: detail asc stops at offset 9,996 (6 ∤ 10,000).
  const capped = ascFinalOffset + DETAIL_PAGE_SIZE > WINDOW_CAP;
  const cutover = ascCheckpoint.lastVisualId ?? 0;
  if (!capped) {
    await markCheckpointComplete(runId, entity);
    return;
  }
  logger.info(
    { runId, entity, cutover },
    "Detail ascending pass hit the 10k cap — sweeping remainder newest-first",
  );

  const client = getPrintavoClient();
  let cursor = rewindCursor(checkpoint.cursor ?? null, RESUME_REWIND);
  let pages = 0;
  let reachedCutover = false;

  for (;;) {
    await yieldToPoll();
    const fetchedAt = new Date();
    const data =
      kind === "invoices"
        ? (await client.query<InvoicesDetailPage>(
            orderDetailPageQuery(kind, cursor),
          )).invoices
        : (await client.query<QuotesDetailPage>(
            orderDetailPageQuery(kind, cursor),
          )).quotes;

    let lastVisualId: number | null = null;
    for (const node of data.nodes) {
      const visual = Number(node.visualId);
      if (Number.isFinite(visual)) {
        lastVisualId = visual;
        // Strictly below cutover — ==cutover twins must still be processed.
        if (visual < cutover) {
          reachedCutover = true;
          break;
        }
      }
      await applyOrderDetail(node, kind, agg, logger, {
        syncRunId: runId,
        fetchedAt,
      });
    }

    pages += 1;
    cursor = data.pageInfo.endCursor;
    await updateCheckpointCursor(runId, entity, cursor, lastVisualId);

    if (pages % 20 === 0) {
      logger.info(
        { runId, entity, pages, agg, cutover, lastVisualId },
        "History detail progress (descending sweep)",
      );
    }
    if (reachedCutover || !data.pageInfo.hasNextPage) break;
    const offset = decodeOffset(cursor);
    if (offset !== null && offset + DETAIL_PAGE_SIZE > WINDOW_CAP) break;
  }

  if (!reachedCutover) {
    logger.warn(
      { runId, entity, cutover },
      "Detail descending sweep ended WITHOUT reaching the ascending cutover — coverage gap",
    );
  }
  await markCheckpointComplete(runId, entity);
  logger.info(
    { runId, entity, pages, agg, reachedCutover },
    "History detail descending sweep completed",
  );
}
