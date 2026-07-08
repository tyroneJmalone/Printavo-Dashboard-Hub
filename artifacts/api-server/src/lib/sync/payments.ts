import type { Logger } from "pino";
import {
  db,
  pvPaymentsTable,
  changeEventsTable,
  type InsertPvPayment,
  type InsertChangeEvent,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  transactionsPageQuery,
  type TransactionsPage,
  type PvTransactionNode,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import { contentHashOf, moneyStr, normalizeTimestamps } from "./differ";
import {
  isSeedActive,
  isPollActive,
  isDetailBackfillActive,
  isPaymentsSeedActive,
  setPaymentsSeedActive,
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
import type { UpsertOpts, UpsertOutcome } from "./upserts";

export { isPaymentsSeedActive } from "./runState";

export async function upsertPayment(
  rawNode: PvTransactionNode,
  opts: UpsertOpts,
): Promise<UpsertOutcome> {
  const node = normalizeTimestamps(rawNode);
  const hash = contentHashOf(node);
  const [existing] = await db
    .select()
    .from(pvPaymentsTable)
    .where(eq(pvPaymentsTable.printavoId, node.id))
    .limit(1);

  if (existing && existing.contentHash === hash) {
    await db
      .update(pvPaymentsTable)
      .set({ syncedAt: new Date() })
      .where(eq(pvPaymentsTable.printavoId, node.id));
    return { outcome: "unchanged", events: 0 };
  }

  const row: InsertPvPayment = {
    printavoId: node.id,
    typename: node.__typename,
    amount: moneyStr(node.amount),
    category: node.category ?? null,
    source: node.source ?? null,
    processing: node.processing ?? null,
    description: node.description ?? null,
    transactionDate: node.transactionDate ?? null,
    orderId: node.transactedFor?.id ?? null,
    orderVisualId: node.transactedFor?.visualId ?? null,
    data: node,
    contentHash: hash,
    syncedAt: new Date(),
  };

  const events: InsertChangeEvent[] = [];
  const base = {
    entityType: "payment",
    entityId: node.id,
    visualId: node.transactedFor?.visualId ?? null,
    syncRunId: opts.syncRunId,
  };

  if (existing) {
    if ((existing.processing ?? null) !== (row.processing ?? null)) {
      events.push({
        ...base,
        eventType: "field_change",
        field: "processing",
        oldValue: existing.processing,
        newValue: row.processing,
      });
    }
    if ((existing.amount ?? null) !== (row.amount ?? null)) {
      events.push({
        ...base,
        eventType: "field_change",
        field: "amount",
        oldValue: existing.amount,
        newValue: row.amount,
      });
    }
    if ((existing.transactionDate ?? null) !== (row.transactionDate ?? null)) {
      events.push({
        ...base,
        eventType: "field_change",
        field: "transactionDate",
        oldValue: existing.transactionDate,
        newValue: row.transactionDate,
      });
    }
    if (events.length === 0) {
      events.push({ ...base, eventType: "updated" });
    }
    await db
      .update(pvPaymentsTable)
      .set(row)
      .where(eq(pvPaymentsTable.printavoId, node.id));
    const emitted = await persistEvents(events, opts);
    return { outcome: "updated", events: emitted };
  }

  events.push({
    ...base,
    eventType: "created",
    newValue: {
      typename: row.typename,
      amount: row.amount,
      transactionDate: row.transactionDate,
    },
  });
  await db.insert(pvPaymentsTable).values(row);
  const emitted = await persistEvents(events, opts);
  return { outcome: "created", events: emitted };
}

async function persistEvents(
  events: InsertChangeEvent[],
  opts: UpsertOpts,
): Promise<number> {
  if (!opts.emitEvents || events.length === 0) return 0;
  await db.insert(changeEventsTable).values(events);
  return events.length;
}

export interface PaymentsAgg {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  events: number;
  pages: number;
  stoppedEarly: boolean;
}

export function newPaymentsAgg(): PaymentsAgg {
  return {
    seen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    events: 0,
    pages: 0,
    stoppedEarly: false,
  };
}

/**
 * Crawl root `transactions` (newest-first, pagination only — no date
 * filter exists). With `stopOnUnchangedPage`, stops as soon as one FULL
 * page comes back entirely hash-unchanged (architect ruling for the
 * 5-minute poll); a periodic full crawl catches backdated edits deeper
 * in the list.
 */
export async function crawlTransactions(
  opts: UpsertOpts,
  options: {
    stopOnUnchangedPage: boolean;
    logger: Logger;
    checkpoint?: { runId: number; entity: string; startCursor: string | null };
  },
): Promise<PaymentsAgg> {
  const client = getPrintavoClient();
  const agg = newPaymentsAgg();
  let cursor: string | null = options.checkpoint?.startCursor ?? null;

  for (;;) {
    const data = await client.query<TransactionsPage>(
      transactionsPageQuery(cursor),
    );
    let pageChanged = false;
    for (const node of data.transactions.nodes) {
      const result = await upsertPayment(node, opts);
      agg.seen += 1;
      agg[result.outcome === "converted" ? "updated" : result.outcome] += 1;
      agg.events += result.events;
      if (result.outcome !== "unchanged") pageChanged = true;
    }
    agg.pages += 1;
    cursor = data.transactions.pageInfo.endCursor;
    if (options.checkpoint) {
      await updateCheckpointCursor(
        options.checkpoint.runId,
        options.checkpoint.entity,
        cursor,
      );
    }
    if (agg.pages % 20 === 0) {
      options.logger.info({ agg }, "Transactions crawl progress");
    }
    if (
      options.stopOnUnchangedPage &&
      !pageChanged &&
      data.transactions.nodes.length >= 25
    ) {
      agg.stoppedEarly = true;
      break;
    }
    if (!data.transactions.pageInfo.hasNextPage) break;
  }
  return agg;
}

export interface PaymentsSeedStart {
  started: boolean;
  syncRunId: number | null;
  message: string;
}

export async function startOrResumePaymentsSeed(
  logger: Logger,
): Promise<PaymentsSeedStart> {
  if (isPaymentsSeedActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "A payments seed is already running",
    };
  }
  if (isSeedActive() || isDetailBackfillActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "Another backfill is running — try again once it finishes",
    };
  }
  if (isPollActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "An incremental poll is running — try again in a moment",
    };
  }
  if (!printavoConfigured()) {
    return {
      started: false,
      syncRunId: null,
      message: "Printavo credentials are not configured yet",
    };
  }
  setPaymentsSeedActive(true);
  let run;
  let resumed = false;
  try {
    run = await findRunningRun("payments_seed");
    resumed = Boolean(run);
    if (!run) {
      run = await createRun("payments_seed");
    }
  } catch (err) {
    setPaymentsSeedActive(false);
    throw err;
  }
  const runId = run.id;
  const startedAt = run.startedAt;
  void runPaymentsSeed(runId, startedAt, logger)
    .catch((err) => {
      logger.error({ err }, "Payments seed crashed");
    })
    .finally(() => {
      setPaymentsSeedActive(false);
    });
  return {
    started: true,
    syncRunId: runId,
    message: resumed
      ? `Resuming interrupted payments seed run #${runId}`
      : `Payments seed run #${runId} started (full history)`,
  };
}

async function runPaymentsSeed(
  runId: number,
  runStartedAt: Date,
  logger: Logger,
): Promise<void> {
  logger.info({ runId }, "Payments seed starting/resuming (full history)");
  try {
    const checkpoint = await getOrCreateCheckpoint(runId, "transactions");
    let agg = newPaymentsAgg();
    if (!checkpoint.completed) {
      agg = await crawlTransactions(
        { emitEvents: false, syncRunId: runId },
        {
          stopOnUnchangedPage: false,
          logger,
          checkpoint: {
            runId,
            entity: "transactions",
            startCursor: checkpoint.cursor ?? null,
          },
        },
      );
      await markCheckpointComplete(runId, "transactions");
    }
    await setWatermark("payments", runStartedAt);
    await setWatermark("payments_daily", runStartedAt);
    await completeRun(runId, { ...agg });
    logger.info({ runId, agg }, "Payments seed completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message).catch(() => undefined);
    logger.error({ runId, err }, "Payments seed failed");
  }
}
