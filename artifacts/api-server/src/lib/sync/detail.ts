import type { Logger } from "pino";
import {
  db,
  pvOrdersTable,
  pvLineItemGroupsTable,
  pvLineItemsTable,
  pvImprintsTable,
  pvOrderLineItemSnapshotsTable,
  changeEventsTable,
  type InsertPvLineItemGroup,
  type InsertPvLineItem,
  type InsertPvImprint,
  type InsertChangeEvent,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import {
  orderDetailPageQuery,
  singleOrderDetailQuery,
  orderGroupsPageQuery,
  type OrderKind,
  type InvoicesDetailPage,
  type QuotesDetailPage,
  type SingleOrderDetail,
  type SingleOrderGroupsPage,
  type PvOrderDetailNode,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import { contentHashOf, dateOrNull, moneyStr, normalizeTimestamps } from "./differ";
import {
  isSeedActive,
  isPollActive,
  isDetailBackfillActive,
  isPaymentsSeedActive,
  isHistoryBackfillActive,
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
import {
  compareLineItemSnapshots,
  isFetchedObservationStale,
  lineItemHistoryHash,
  lineItemHistoryStates,
  type LineItemHistoryState,
} from "./lineItemHistory";

export { isDetailBackfillActive } from "./runState";

export type DetailOutcome =
  | "written"
  | "unchanged"
  | "stale"
  | "missing_order"
  | "truncated";

export interface DetailAgg {
  seen: number;
  written: number;
  unchanged: number;
  stale: number;
  missingOrder: number;
  toppedUp: number;
  truncated: number;
}

export function newDetailAgg(): DetailAgg {
  return {
    seen: 0,
    written: 0,
    unchanged: 0,
    stale: 0,
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

/** A detail response is safe for replacement/history only when complete. */
export function isCompleteOrderDetail(node: PvOrderDetailNode): boolean {
  return !isTruncated(node);
}

async function markDetailIncomplete(
  orderId: string,
  fetchedAt: Date,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${orderId}, 0))`,
    );
    const [order] = await tx
      .select({ detailFetchStartedAt: pvOrdersTable.detailFetchStartedAt })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.printavoId, orderId))
      .limit(1);
    if (
      !order ||
      isFetchedObservationStale(fetchedAt, order.detailFetchStartedAt)
    ) {
      return;
    }
    await tx
      .update(pvOrdersTable)
      .set({
        detailSyncState: "incomplete",
        detailSyncError: reason,
        detailFetchStartedAt: fetchedAt,
      })
      .where(eq(pvOrdersTable.printavoId, orderId));
  });
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
  opts?: {
    force?: boolean;
    syncRunId?: number | null;
    fetchedAt?: Date;
  },
): Promise<DetailOutcome> {
  agg.seen += 1;
  const fetchedAt = opts?.fetchedAt ?? new Date();

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
    // Orders with more groups than the single query's first page (>20):
    // follow the group cursor until exhausted (backup-module fix for the
    // known >25-group truncations).
    let groupsPage = node.lineItemGroups.pageInfo;
    while (groupsPage.hasNextPage && groupsPage.endCursor) {
      const pageData = await client.query<SingleOrderGroupsPage>(
        orderGroupsPageQuery(singleKind, node.id, groupsPage.endCursor),
      );
      const cont = pageData.invoice ?? pageData.quote ?? null;
      if (!cont) break;
      node.lineItemGroups.nodes.push(...cont.lineItemGroups.nodes);
      groupsPage = cont.lineItemGroups.pageInfo;
    }
    node.lineItemGroups.pageInfo = { hasNextPage: groupsPage.hasNextPage };
    if (!isCompleteOrderDetail(node)) {
      // >40 line items or >15 imprints within one group — do not replace
      // children or emit deletions from incomplete data.
      agg.truncated += 1;
      const reason =
        "Nested line-item or imprint pagination remains after supported top-up";
      await markDetailIncomplete(node.id, fetchedAt, reason);
      logger.warn(
        { orderId: node.id, visualId: node.visualId },
        `Order detail incomplete — skipped: ${reason}`,
      );
      return "truncated";
    }
  }

  // Hash compatibility: the single-order query now returns endCursor on
  // the groups pageInfo (for group paging); strip it so hashes stay
  // identical to the page-crawl path, which never requests it.
  node = {
    ...node,
    lineItemGroups: {
      ...node.lineItemGroups,
      pageInfo: { hasNextPage: node.lineItemGroups.pageInfo.hasNextPage },
    },
  };

  // Sweep-triggered refreshes pass force: the sweep has already proven
  // the DB rows disagree with the API, so the stored hash cannot be
  // trusted as evidence the rows are current (a drifted row with a
  // matching hash would otherwise be re-flagged and skipped forever).
  const hash = detailHashOf(node);
  const currentStates = lineItemHistoryStates(node.lineItemGroups.nodes);
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    // Every read that determines the before-state is protected by the same
    // per-order lock as the replacement.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${node.id}, 0))`,
    );
    const [order] = await tx
      .select({
        printavoId: pvOrdersTable.printavoId,
        detailContentHash: pvOrdersTable.detailContentHash,
        detailFetchStartedAt: pvOrdersTable.detailFetchStartedAt,
      })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.printavoId, node.id))
      .limit(1);
    if (!order) return "missing_order" as const;

    // Reject a response that started before an already-accepted newer one.
    if (isFetchedObservationStale(fetchedAt, order.detailFetchStartedAt)) {
      return "stale" as const;
    }

    const [latestSnapshot] = await tx
      .select()
      .from(pvOrderLineItemSnapshotsTable)
      .where(eq(pvOrderLineItemSnapshotsTable.orderId, node.id))
      .orderBy(desc(pvOrderLineItemSnapshotsTable.id))
      .limit(1);
    const previousStates = latestSnapshot
      ? (latestSnapshot.lineItems as LineItemHistoryState[])
      : [];
    const baseline = latestSnapshot === undefined;
    if (!opts?.force && order.detailContentHash === hash) {
      // Rows written before line-item history was introduced have a detail
      // hash but no observation. Capture this first complete response as the
      // baseline without inventing additions.
      if (baseline) {
        await tx.insert(pvOrderLineItemSnapshotsTable).values({
          orderId: node.id,
          observedAt: now,
          syncRunId: opts?.syncRunId ?? null,
          contentHash: lineItemHistoryHash(currentStates),
          lineItems: currentStates,
        });
      }
      await tx
        .update(pvOrdersTable)
        .set({
          detailSyncedAt: now,
          detailFetchStartedAt: fetchedAt,
          detailSyncState: "complete",
          detailSyncError: null,
        })
        .where(eq(pvOrdersTable.printavoId, node.id));
      return "unchanged" as const;
    }

    // Line-item product status activity log (Needs Ordering / Ordered / ...):
    // Printavo exposes no event timestamps or audit log for these changes,
    // so we record the transition at OBSERVATION time whenever a detail
    // rewrite lands a different status than what was stored. This is the
    // single choke point for local product_status writes (delete+reinsert
    // below), so it covers manual Printavo edits AND hub PO write-backs.
    const previousStatuses = new Map(
      (
        await tx
          .select({
            printavoId: pvLineItemsTable.printavoId,
            productStatus: pvLineItemsTable.productStatus,
          })
          .from(pvLineItemsTable)
          .where(eq(pvLineItemsTable.orderId, node.id))
      ).map((r) => [r.printavoId, r.productStatus]),
    );

    const groupRows: InsertPvLineItemGroup[] = [];
    const itemRows: InsertPvLineItem[] = [];
    const imprintRows: InsertPvImprint[] = [];
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

    const statusEvents: InsertChangeEvent[] = [];
    for (const row of itemRows) {
      if (!previousStatuses.has(row.printavoId)) continue;
      const oldStatus = previousStatuses.get(row.printavoId) ?? null;
      const newStatus = row.productStatus ?? null;
      if (oldStatus !== newStatus) {
        statusEvents.push({
          entityType: "line_item",
          entityId: row.printavoId,
          orderId: node.id,
          visualId: node.visualId ?? null,
          eventType: "status_change",
          field: "productStatus",
          oldValue: oldStatus,
          newValue: newStatus,
          occurredAt: now,
          syncRunId: opts?.syncRunId ?? null,
        });
      }
    }

    const lineItemChanges = compareLineItemSnapshots(
      previousStates,
      currentStates,
      baseline,
    );
    const lineItemEvents: InsertChangeEvent[] = lineItemChanges.map((change) => ({
      entityType: "line_item",
      entityId: change.lineItemId,
      orderId: node.id,
      visualId: node.visualId ?? null,
      eventType:
        change.kind === "added"
          ? "created"
          : change.kind === "removed"
            ? "deleted"
            : "field_change",
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      occurredAt: now,
      syncRunId: opts?.syncRunId ?? null,
    }));
    const snapshotHash = lineItemHistoryHash(currentStates);
    const shouldWriteSnapshot =
      baseline ||
      lineItemChanges.length > 0 ||
      latestSnapshot?.contentHash !== snapshotHash;

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
    if (statusEvents.length > 0 || lineItemEvents.length > 0) {
      await tx
        .insert(changeEventsTable)
        .values([...statusEvents, ...lineItemEvents]);
    }
    if (shouldWriteSnapshot) {
      await tx.insert(pvOrderLineItemSnapshotsTable).values({
        orderId: node.id,
        observedAt: now,
        syncRunId: opts?.syncRunId ?? null,
        contentHash: snapshotHash,
        lineItems: currentStates,
      });
    }
    await tx
      .update(pvOrdersTable)
      .set({
        detailContentHash: hash,
        detailSyncedAt: now,
        detailFetchStartedAt: fetchedAt,
        detailSyncState: "complete",
        detailSyncError: null,
      })
      .where(eq(pvOrdersTable.printavoId, node.id));
    return "written" as const;
  });
  if (outcome === "missing_order") agg.missingOrder += 1;
  if (outcome === "stale") agg.stale += 1;
  if (outcome === "unchanged") agg.unchanged += 1;
  if (outcome === "written") agg.written += 1;
  return outcome;
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
  opts?: {
    force?: boolean;
    syncRunId?: number | null;
    fetchedAt?: Date;
  },
): Promise<DetailOutcome> {
  const singleKind = kind === "invoices" ? "invoice" : "quote";
  const client = getPrintavoClient();
  const fetchedAt = opts?.fetchedAt ?? new Date();
  const data = await client.query<SingleOrderDetail>(
    singleOrderDetailQuery(singleKind, orderId),
  );
  const node = data.invoice ?? data.quote ?? null;
  if (!node) {
    agg.seen += 1;
    agg.missingOrder += 1;
    return "missing_order";
  }
  return applyOrderDetail(node, kind, agg, logger, { ...opts, fetchedAt });
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
  opts?: { syncRunId?: number | null },
): Promise<void> {
  const client = getPrintavoClient();
  let cursor: string | null = checkpoint?.startCursor ?? null;
  let pages = 0;

  for (;;) {
    const fetchedAt = new Date();
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
      await applyOrderDetail(node, kind, agg, logger, {
        syncRunId: opts?.syncRunId ?? checkpoint?.runId ?? null,
        fetchedAt,
      });
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
  if (isHistoryBackfillActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "A history backfill is running — try again once it finishes",
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
