import type { Logger } from "pino";
import {
  db,
  pvOrdersTable,
  pvLineItemGroupsTable,
  pvLineItemsTable,
  pvImprintsTable,
  type InsertPvLineItemGroup,
  type InsertPvLineItem,
  type InsertPvImprint,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  orderDetailPageQuery,
  singleOrderDetailQuery,
  type OrderKind,
  type InvoicesDetailPage,
  type QuotesDetailPage,
  type SingleOrderDetail,
  type PvOrderDetailNode,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import { contentHashOf, dateOrNull, moneyStr, normalizeTimestamps } from "./differ";
import {
  isSeedActive,
  isPollActive,
  isDetailBackfillActive,
  isPaymentsSeedActive,
  setDetailBackfillActive,
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
import { SEED_MONTHS } from "./seed";

export { isDetailBackfillActive } from "./runState";

export type DetailOutcome =
  | "written"
  | "unchanged"
  | "missing_order"
  | "truncated";

export interface DetailAgg {
  seen: number;
  written: number;
  unchanged: number;
  missingOrder: number;
  toppedUp: number;
  truncated: number;
}

export function newDetailAgg(): DetailAgg {
  return {
    seen: 0,
    written: 0,
    unchanged: 0,
    missingOrder: 0,
    toppedUp: 0,
    truncated: 0,
  };
}

function isTruncated(node: PvOrderDetailNode): boolean {
  if (node.lineItemGroups.pageInfo.hasNextPage) return true;
  return node.lineItemGroups.nodes.some(
    (g) => g.lineItems.pageInfo.hasNextPage || g.imprints.pageInfo.hasNextPage,
  );
}

/**
 * The detail hash covers ONLY the lineItemGroups subtree (normalized), so
 * unrelated order edits (status, nickname, ...) never force a child rewrite.
 */
function detailHashOf(node: PvOrderDetailNode): string {
  return contentHashOf(normalizeTimestamps(node.lineItemGroups));
}

/**
 * Apply one order's detail payload: if the hash differs from what is
 * stored, delete + reinsert all children in a single transaction
 * (architect ruling: one detail hash per order, order-granular replace).
 *
 * If the page-crawl node is truncated (nested hasNextPage), tops up with
 * the generous single-order query before applying.
 */
export async function applyOrderDetail(
  pageNode: PvOrderDetailNode,
  kind: OrderKind,
  agg: DetailAgg,
  logger: Logger,
): Promise<DetailOutcome> {
  agg.seen += 1;

  const [order] = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      detailContentHash: pvOrdersTable.detailContentHash,
    })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.printavoId, pageNode.id))
    .limit(1);
  if (!order) {
    agg.missingOrder += 1;
    return "missing_order";
  }

  let node = pageNode;
  if (isTruncated(node)) {
    const singleKind = kind === "invoices" ? "invoice" : "quote";
    const client = getPrintavoClient();
    const data = await client.query<SingleOrderDetail>(
      singleOrderDetailQuery(singleKind, node.id),
    );
    const full = data.invoice ?? data.quote ?? null;
    if (!full) {
      agg.missingOrder += 1;
      return "missing_order";
    }
    node = full;
    agg.toppedUp += 1;
    if (isTruncated(node)) {
      // >25 groups / >50 line items / >25 imprints — store what we have
      // but flag loudly; nothing in this account should hit this.
      agg.truncated += 1;
      logger.warn(
        { orderId: node.id, visualId: node.visualId },
        "Order detail truncated even at generous limits",
      );
    }
  }

  const hash = detailHashOf(node);
  if (order.detailContentHash === hash) {
    await db
      .update(pvOrdersTable)
      .set({ detailSyncedAt: new Date() })
      .where(eq(pvOrdersTable.printavoId, node.id));
    agg.unchanged += 1;
    return "unchanged";
  }

  const groupRows: InsertPvLineItemGroup[] = [];
  const itemRows: InsertPvLineItem[] = [];
  const imprintRows: InsertPvImprint[] = [];
  const now = new Date();
  for (const group of node.lineItemGroups.nodes) {
    groupRows.push({
      printavoId: group.id,
      orderId: node.id,
      position: group.position ?? null,
      syncedAt: now,
    });
    for (const li of group.lineItems.nodes) {
      itemRows.push({
        printavoId: li.id,
        groupId: group.id,
        orderId: node.id,
        itemNumber: li.itemNumber ?? null,
        color: li.color ?? null,
        description: li.description ?? null,
        categoryId: li.category?.id ?? null,
        categoryName: li.category?.name ?? null,
        brand: li.product?.brand ?? null,
        productId: li.product?.id ?? null,
        items: li.items ?? 0,
        price: moneyStr(li.price),
        merch: li.merch ?? false,
        productStatus: li.productStatus ?? null,
        sizes: li.sizes ?? null,
        syncedAt: now,
      });
    }
    for (const imp of group.imprints.nodes) {
      imprintRows.push({
        printavoId: imp.id,
        groupId: group.id,
        orderId: node.id,
        details: imp.details ?? null,
        matrixName: imp.pricingMatrixColumn?.matrix?.name ?? null,
        columnName: imp.pricingMatrixColumn?.columnName ?? null,
        typeOfWork: imp.typeOfWork?.name ?? null,
        syncedAt: now,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(pvLineItemGroupsTable)
      .where(eq(pvLineItemGroupsTable.orderId, node.id));
    if (groupRows.length > 0) {
      await tx.insert(pvLineItemGroupsTable).values(groupRows);
    }
    if (itemRows.length > 0) {
      await tx.insert(pvLineItemsTable).values(itemRows);
    }
    if (imprintRows.length > 0) {
      await tx.insert(pvImprintsTable).values(imprintRows);
    }
    await tx
      .update(pvOrdersTable)
      .set({ detailContentHash: hash, detailSyncedAt: now })
      .where(eq(pvOrdersTable.printavoId, node.id));
  });
  agg.written += 1;
  return "written";
}

/**
 * Fetch + apply detail for a single order (used by the incremental poll
 * when an order's list-level hash changed).
 */
export async function refreshOrderDetail(
  orderId: string,
  kind: OrderKind,
  agg: DetailAgg,
  logger: Logger,
): Promise<DetailOutcome> {
  const singleKind = kind === "invoices" ? "invoice" : "quote";
  const client = getPrintavoClient();
  const data = await client.query<SingleOrderDetail>(
    singleOrderDetailQuery(singleKind, orderId),
  );
  const node = data.invoice ?? data.quote ?? null;
  if (!node) {
    agg.seen += 1;
    agg.missingOrder += 1;
    return "missing_order";
  }
  return applyOrderDetail(node, kind, agg, logger);
}

/**
 * Crawl one order kind's detail pages newest-first until the cutoff,
 * applying each order's detail. Shared by backfill and nightly re-crawl.
 */
export async function crawlDetailEntity(
  kind: OrderKind,
  cutoff: Date,
  agg: DetailAgg,
  logger: Logger,
  checkpoint?: {
    runId: number;
    entity: string;
    startCursor: string | null;
  },
): Promise<void> {
  const client = getPrintavoClient();
  let cursor: string | null = checkpoint?.startCursor ?? null;
  let pages = 0;

  for (;;) {
    const data =
      kind === "invoices"
        ? (await client.query<InvoicesDetailPage>(
            orderDetailPageQuery(kind, cursor),
          )).invoices
        : (await client.query<QuotesDetailPage>(
            orderDetailPageQuery(kind, cursor),
          )).quotes;

    let reachedCutoff = false;
    for (const node of data.nodes) {
      const createdAt = dateOrNull(node.timestamps?.createdAt);
      if (createdAt && createdAt < cutoff) {
        reachedCutoff = true;
        break;
      }
      await applyOrderDetail(node, kind, agg, logger);
    }

    pages += 1;
    cursor = data.pageInfo.endCursor;
    if (checkpoint) {
      await updateCheckpointCursor(checkpoint.runId, checkpoint.entity, cursor);
    }
    if (pages % 20 === 0) {
      logger.info({ kind, pages, agg }, "Detail crawl progress");
    }
    if (reachedCutoff || !data.pageInfo.hasNextPage) break;
  }
}

export interface DetailBackfillStart {
  started: boolean;
  syncRunId: number | null;
  message: string;
}

const DETAIL_ENTITIES: Array<{ kind: OrderKind; entity: string }> = [
  { kind: "invoices", entity: "invoices_detail" },
  { kind: "quotes", entity: "quotes_detail" },
];

export async function startOrResumeDetailBackfill(
  logger: Logger,
): Promise<DetailBackfillStart> {
  if (isDetailBackfillActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "A detail backfill is already running",
    };
  }
  if (isSeedActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "Seed is running — try again once it finishes",
    };
  }
  if (isPollActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "An incremental poll is running — try again in a moment",
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
  setDetailBackfillActive(true);
  let run;
  let resumed = false;
  try {
    run = await findRunningRun("detail_backfill");
    resumed = Boolean(run);
    if (!run) {
      run = await createRun("detail_backfill");
    }
  } catch (err) {
    setDetailBackfillActive(false);
    throw err;
  }
  const runId = run.id;
  const startedAt = run.startedAt;
  void runDetailBackfill(runId, startedAt, logger)
    .catch((err) => {
      logger.error({ err }, "Detail backfill crashed");
    })
    .finally(() => {
      setDetailBackfillActive(false);
    });
  return {
    started: true,
    syncRunId: runId,
    message: resumed
      ? `Resuming interrupted detail backfill run #${runId}`
      : `Detail backfill run #${runId} started (last ${SEED_MONTHS} months)`,
  };
}

async function runDetailBackfill(
  runId: number,
  runStartedAt: Date,
  logger: Logger,
): Promise<void> {
  const cutoff = new Date(runStartedAt);
  cutoff.setMonth(cutoff.getMonth() - SEED_MONTHS);
  logger.info(
    { runId, cutoff: cutoff.toISOString() },
    "Detail backfill starting/resuming",
  );
  const agg = newDetailAgg();
  try {
    for (const { kind, entity } of DETAIL_ENTITIES) {
      const checkpoint = await getOrCreateCheckpoint(runId, entity);
      if (checkpoint.completed) continue;
      await crawlDetailEntity(kind, cutoff, agg, logger, {
        runId,
        entity,
        startCursor: checkpoint.cursor ?? null,
      });
      await markCheckpointComplete(runId, entity);
      logger.info({ runId, entity, agg }, "Detail backfill entity completed");
    }
    await setWatermark("details", runStartedAt);
    await setWatermark("details_daily", runStartedAt);
    await completeRun(runId, { ...agg, cutoff: cutoff.toISOString() });
    logger.info({ runId, agg }, "Detail backfill completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message).catch(() => undefined);
    logger.error({ runId, err }, "Detail backfill failed");
  }
}
