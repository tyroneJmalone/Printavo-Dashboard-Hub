import type { Logger } from "pino";
import { db, pvOrdersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  orderExtrasQuery,
  orderExtrasGroupsPageQuery,
  orderExtrasConnectionPageQuery,
  type Connection,
  type SingleOrderExtras,
  type SingleOrderExtrasGroupsPage,
  type PvOrderExtrasBlob,
  type PvExtrasGroupNode,
} from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { contentHashOf, normalizeTimestamps } from "./differ";

/**
 * Backup module — per-order "extras" capture.
 *
 * Everything the hot sync paths skip (fees, expenses, approval requests,
 * production files, custom addresses, thread summary, payment request,
 * contractor profile, plus line-item/imprint enrichment: mockups,
 * personalizations, price receipts, product catalog refs, PO links) is
 * fetched by a supplemental per-order query and stored as ONE raw jsonb
 * blob in pv_orders.extras. No hot columns — portability first; anything
 * that later needs fast querying can be promoted or extracted.
 *
 * Refresh model: pv_orders.extras_stale is set TRUE whenever the list
 * crawl sees the order change (and defaults TRUE for new rows). The drip
 * (runExtrasDrip, called from scheduled polls with a per-poll cap) works
 * the stale/missing backlog newest-first, so fresh orders win.
 */

export type ExtrasOutcome = "written" | "unchanged" | "missing_order";

export interface ExtrasAgg {
  seen: number;
  written: number;
  unchanged: number;
  missingOrder: number;
  truncated: number;
  errors: number;
}

export function newExtrasAgg(): ExtrasAgg {
  return {
    seen: 0,
    written: 0,
    unchanged: 0,
    missingOrder: 0,
    truncated: 0,
    errors: 0,
  };
}

type SingleKind = "invoice" | "quote";

type ExtrasConnectionName =
  | "fees"
  | "expenses"
  | "approvalRequests"
  | "productionFiles"
  | "customAddresses";

/** Follow an overflowed order-level connection to the end (rare, >25 nodes). */
async function drainConnection<T>(
  kind: SingleKind,
  orderId: string,
  name: ExtrasConnectionName,
  conn: Connection<T> | null | undefined,
): Promise<T[]> {
  if (!conn) return [];
  const nodes = [...conn.nodes];
  let pageInfo = conn.pageInfo;
  const client = getPrintavoClient();
  while (pageInfo.hasNextPage && pageInfo.endCursor) {
    const data = await client.query<
      Record<string, ({ id: string } & Record<string, Connection<T>>) | null>
    >(orderExtrasConnectionPageQuery(kind, orderId, name, pageInfo.endCursor));
    const parent = data.invoice ?? data.quote ?? null;
    const page = parent?.[name];
    if (!page) break;
    nodes.push(...page.nodes);
    pageInfo = page.pageInfo;
  }
  return nodes;
}

/**
 * Fetch and assemble the full extras blob for one order, following
 * pagination on line item groups and every order-level connection.
 * Returns null if the order no longer exists in Printavo.
 */
export async function fetchExtrasBlob(
  kind: SingleKind,
  orderId: string,
): Promise<PvOrderExtrasBlob | null> {
  const client = getPrintavoClient();
  const data = await client.query<SingleOrderExtras>(
    orderExtrasQuery(kind, orderId),
  );
  const node = data.invoice ?? data.quote ?? null;
  if (!node) return null;

  // Page groups beyond the first EXTRAS_GROUPS_FIRST.
  const groups: PvExtrasGroupNode[] = [...node.lineItemGroups.nodes];
  let groupsPage = node.lineItemGroups.pageInfo;
  while (groupsPage.hasNextPage && groupsPage.endCursor) {
    const pageData = await client.query<SingleOrderExtrasGroupsPage>(
      orderExtrasGroupsPageQuery(kind, orderId, groupsPage.endCursor),
    );
    const cont = pageData.invoice ?? pageData.quote ?? null;
    if (!cont) break;
    groups.push(...cont.lineItemGroups.nodes);
    groupsPage = cont.lineItemGroups.pageInfo;
  }

  // Flatten line items / imprints; note any nested overflow we cannot
  // page (per-group line items >25, mockups >6 — loudly rare).
  let truncated = false;
  const lineItems: PvOrderExtrasBlob["lineItems"] = [];
  const imprints: PvOrderExtrasBlob["imprints"] = [];
  for (const group of groups) {
    if (
      group.lineItems.pageInfo.hasNextPage ||
      group.imprints.pageInfo.hasNextPage
    ) {
      truncated = true;
    }
    for (const li of group.lineItems.nodes) {
      if (li.mockups.pageInfo.hasNextPage) truncated = true;
      const { mockups, ...rest } = li;
      lineItems.push({ ...rest, mockups: mockups.nodes });
    }
    for (const imp of group.imprints.nodes) {
      if (imp.mockups.pageInfo.hasNextPage) truncated = true;
      imprints.push({ id: imp.id, mockups: imp.mockups.nodes });
    }
  }

  const fees = await drainConnection(kind, orderId, "fees", node.fees);
  const expenses = await drainConnection(
    kind,
    orderId,
    "expenses",
    node.expenses,
  );
  const approvalRequests = await drainConnection(
    kind,
    orderId,
    "approvalRequests",
    node.approvalRequests,
  );
  const productionFiles = await drainConnection(
    kind,
    orderId,
    "productionFiles",
    node.productionFiles,
  );
  const customAddresses = await drainConnection(
    kind,
    orderId,
    "customAddresses",
    node.customAddresses,
  );

  return {
    fees,
    expenses,
    approvalRequests,
    productionFiles,
    customAddresses,
    threadSummary: node.threadSummary ?? null,
    paymentRequest: node.paymentRequest ?? null,
    contractorProfile: node.contractorProfile ?? null,
    lineItems,
    imprints,
    truncated,
  };
}

/**
 * Fetch + persist extras for one order. Hash-guarded: identical payloads
 * only bump extras_synced_at (and clear the stale flag).
 */
export async function applyOrderExtras(
  orderId: string,
  orderType: "invoice" | "quote",
  agg: ExtrasAgg,
  logger: Logger,
): Promise<ExtrasOutcome> {
  agg.seen += 1;
  const blob = await fetchExtrasBlob(orderType, orderId);
  const now = new Date();

  if (!blob) {
    // Order gone from Printavo — clear the flag so the drip moves on.
    await db
      .update(pvOrdersTable)
      .set({ extrasSyncedAt: now, extrasStale: false })
      .where(eq(pvOrdersTable.printavoId, orderId));
    agg.missingOrder += 1;
    return "missing_order";
  }

  if (blob.truncated) {
    agg.truncated += 1;
    logger.warn(
      { orderId },
      "Order extras truncated (nested connection overflow beyond paging)",
    );
  }

  const normalized = normalizeTimestamps(blob);
  const hash = contentHashOf(normalized);
  const [existing] = await db
    .select({ extrasContentHash: pvOrdersTable.extrasContentHash })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.printavoId, orderId))
    .limit(1);
  if (!existing) {
    agg.missingOrder += 1;
    return "missing_order";
  }

  if (existing.extrasContentHash === hash) {
    await db
      .update(pvOrdersTable)
      .set({ extrasSyncedAt: now, extrasStale: false })
      .where(eq(pvOrdersTable.printavoId, orderId));
    agg.unchanged += 1;
    return "unchanged";
  }

  await db
    .update(pvOrdersTable)
    .set({
      extras: normalized,
      extrasContentHash: hash,
      extrasSyncedAt: now,
      extrasStale: false,
    })
    .where(eq(pvOrdersTable.printavoId, orderId));
  agg.written += 1;
  return "written";
}

/**
 * Work the extras backlog (stale or never captured), newest orders first,
 * up to `limit` orders. Called from scheduled polls; each order costs
 * 1+ API request (~0.62s), so the cap bounds poll length.
 */
export async function runExtrasDrip(
  limit: number,
  logger: Logger,
): Promise<ExtrasAgg> {
  const agg = newExtrasAgg();
  const candidates = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      orderType: pvOrdersTable.orderType,
      visualId: pvOrdersTable.visualId,
    })
    .from(pvOrdersTable)
    // extras_stale alone drives selection: it defaults true for new rows and
    // is re-set on every order upsert. Do NOT also match `extras IS NULL` —
    // the missing_order path clears the flag while leaving extras NULL, and
    // matching on NULL would re-select those rows every cycle forever.
    .where(eq(pvOrdersTable.extrasStale, true))
    .orderBy(desc(pvOrdersTable.visualId))
    .limit(limit);

  for (const candidate of candidates) {
    try {
      await applyOrderExtras(
        candidate.printavoId,
        candidate.orderType === "invoice" ? "invoice" : "quote",
        agg,
        logger,
      );
    } catch (err) {
      agg.errors += 1;
      logger.error(
        { err, orderId: candidate.printavoId, visualId: candidate.visualId },
        "Extras capture failed for order",
      );
    }
  }

  if (agg.seen > 0) {
    logger.info({ agg }, "Extras drip cycle complete");
  }
  return agg;
}
