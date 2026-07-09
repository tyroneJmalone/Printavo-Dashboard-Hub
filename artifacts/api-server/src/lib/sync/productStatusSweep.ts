import type { Logger } from "pino";
import { db, pvLineItemsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  productStatusSweepPageQuery,
  type ProductStatusSweepPage,
} from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { dateOrNull } from "./differ";

/**
 * Product-status sweep.
 *
 * Printavo does NOT bump an order's updatedAt when a line item's
 * productStatus changes (verified live July 2026: flagging items
 * "need_ordering" left the order's timestamps untouched), so the
 * hash-based list crawl never notices and the Vendor Orders queue goes
 * stale until the once-a-day full detail re-crawl.
 *
 * This sweep crawls a slim page (line item id + productStatus only) of
 * the newest invoices, diffs against pv_line_items, and reports the
 * orders whose statuses disagree so the poll can re-pull their details.
 *
 * Scope notes:
 * - Invoices only — the purchasing workflow flags invoices; the legacy
 *   PO Builder scanned invoices only for years without a miss.
 * - Nested connections are capped (5 groups / 8 items); items beyond the
 *   caps are invisible to the sweep and covered by the daily re-crawl.
 */

export interface SweepAgg {
  pages: number;
  ordersSeen: number;
  itemsChecked: number;
  mismatchedOrders: number;
}

export interface SweepResult {
  agg: SweepAgg;
  /** Printavo order ids whose line item statuses disagree with the DB. */
  mismatchedOrderIds: string[];
}

export async function sweepProductStatuses(
  maxPages: number,
  cutoff: Date,
  logger: Logger,
): Promise<SweepResult> {
  const client = getPrintavoClient();
  const agg: SweepAgg = {
    pages: 0,
    ordersSeen: 0,
    itemsChecked: 0,
    mismatchedOrders: 0,
  };
  const mismatched = new Set<string>();

  let cursor: string | null = null;
  let reachedCutoff = false;

  while (agg.pages < maxPages && !reachedCutoff) {
    const data: ProductStatusSweepPage =
      await client.query<ProductStatusSweepPage>(
        productStatusSweepPageQuery(cursor),
      );
    agg.pages += 1;

    // liId -> { apiStatus, orderId } for this page only (keeps the DB
    // lookup bounded at ~1000 ids per page).
    const pageItems = new Map<
      string,
      { apiStatus: string; orderId: string }
    >();
    for (const node of data.invoices.nodes) {
      const createdAt = dateOrNull(node.timestamps?.createdAt);
      if (createdAt && createdAt < cutoff) {
        reachedCutoff = true;
        break;
      }
      agg.ordersSeen += 1;
      for (const group of node.lineItemGroups.nodes) {
        for (const li of group.lineItems.nodes) {
          pageItems.set(li.id, {
            apiStatus: li.productStatus ?? "",
            orderId: node.id,
          });
        }
      }
    }

    if (pageItems.size > 0) {
      agg.itemsChecked += pageItems.size;
      const rows = await db
        .select({
          printavoId: pvLineItemsTable.printavoId,
          productStatus: pvLineItemsTable.productStatus,
        })
        .from(pvLineItemsTable)
        .where(inArray(pvLineItemsTable.printavoId, [...pageItems.keys()]));
      const dbStatus = new Map(
        rows.map((r) => [r.printavoId, r.productStatus ?? ""]),
      );
      for (const [liId, { apiStatus, orderId }] of pageItems) {
        // Unknown line item ids mean the order changed shape without the
        // list hash moving — refresh those orders too. (Orders missing
        // from pv_orders entirely are handled downstream as no-ops.)
        const stored = dbStatus.get(liId);
        if (stored === undefined || stored !== apiStatus) {
          mismatched.add(orderId);
        }
      }
    }

    if (!data.invoices.pageInfo.hasNextPage) break;
    cursor = data.invoices.pageInfo.endCursor;
  }

  agg.mismatchedOrders = mismatched.size;
  if (mismatched.size > 0) {
    logger.info(
      { ...agg, orderIds: [...mismatched] },
      "Product-status sweep found stale orders",
    );
  }
  return { agg, mismatchedOrderIds: [...mismatched] };
}
