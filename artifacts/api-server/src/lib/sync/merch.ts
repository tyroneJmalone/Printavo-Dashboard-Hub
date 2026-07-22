import type { Logger } from "pino";
import { db, pvMerchStoresTable, pvMerchOrdersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  merchStoresPageQuery,
  merchStoreOrdersPageQuery,
  type Connection,
} from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { contentHashOf, dateOrNull, moneyStr, normalizeTimestamps } from "./differ";

interface MerchStoreNode {
  id: string;
  name?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

interface MerchOrderNode {
  id: string;
  visualId?: number | string | null;
  status?: string | null;
  total?: number | null;
  completedAt?: string | null;
  [key: string]: unknown;
}

interface MerchStoresResponse {
  merchStores: Connection<MerchStoreNode>;
}

interface MerchStoreOrdersResponse {
  merchStore: { id: string; orders: Connection<MerchOrderNode> } | null;
}

export interface MerchAgg {
  stores: number;
  storesWritten: number;
  orders: number;
  ordersWritten: number;
  unchanged: number;
}

/**
 * Backup module (B4c): daily merch sweep. Crawls all merch stores,
 * then pages EVERY store's orders (merch orders have no root list).
 * Full re-crawl each run — the store count is tiny and hash-guarded
 * writes keep it cheap.
 */
export async function crawlMerch(logger: Logger): Promise<MerchAgg> {
  const client = getPrintavoClient();
  const agg: MerchAgg = {
    stores: 0,
    storesWritten: 0,
    orders: 0,
    ordersWritten: 0,
    unchanged: 0,
  };

  const storeIds: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const data: MerchStoresResponse = await client.query<MerchStoresResponse>(
      merchStoresPageQuery(cursor),
    );
    for (const rawNode of data.merchStores.nodes) {
      const node = normalizeTimestamps(rawNode);
      const hash = contentHashOf(node);
      agg.stores += 1;
      storeIds.push(node.id);

      const [existing] = await db
        .select({ contentHash: pvMerchStoresTable.contentHash })
        .from(pvMerchStoresTable)
        .where(eq(pvMerchStoresTable.printavoId, node.id))
        .limit(1);
      if (existing && existing.contentHash === hash) {
        await db
          .update(pvMerchStoresTable)
          .set({ syncedAt: new Date() })
          .where(eq(pvMerchStoresTable.printavoId, node.id));
        agg.unchanged += 1;
      } else {
        const row = {
          printavoId: node.id,
          name: node.name ?? null,
          status: node.status ?? null,
          data: node,
          contentHash: hash,
          syncedAt: new Date(),
        };
        await db
          .insert(pvMerchStoresTable)
          .values(row)
          .onConflictDoUpdate({
            target: pvMerchStoresTable.printavoId,
            set: {
              name: row.name,
              status: row.status,
              data: row.data,
              contentHash: row.contentHash,
              syncedAt: row.syncedAt,
            },
          });
        agg.storesWritten += 1;
      }
    }
    if (!data.merchStores.pageInfo.hasNextPage) break;
    cursor = data.merchStores.pageInfo.endCursor;
  }

  for (const storeId of storeIds) {
    let orderCursor: string | null = null;
    for (;;) {
      const data: MerchStoreOrdersResponse =
        await client.query<MerchStoreOrdersResponse>(
          merchStoreOrdersPageQuery(storeId, orderCursor),
        );
      const orders = data.merchStore?.orders;
      if (!orders) {
        logger.warn({ storeId }, "Merch store vanished mid-crawl — skipping");
        break;
      }
      for (const rawNode of orders.nodes) {
        const node = normalizeTimestamps(rawNode);
        const hash = contentHashOf(node);
        agg.orders += 1;

        const [existing] = await db
          .select({ contentHash: pvMerchOrdersTable.contentHash })
          .from(pvMerchOrdersTable)
          .where(eq(pvMerchOrdersTable.printavoId, node.id))
          .limit(1);
        if (existing && existing.contentHash === hash) {
          await db
            .update(pvMerchOrdersTable)
            .set({ syncedAt: new Date() })
            .where(eq(pvMerchOrdersTable.printavoId, node.id));
          agg.unchanged += 1;
          continue;
        }

        const row = {
          printavoId: node.id,
          visualId: node.visualId != null ? String(node.visualId) : null,
          storePrintavoId: storeId,
          status: node.status ?? null,
          total: moneyStr(node.total),
          completedAt: dateOrNull(node.completedAt),
          data: node,
          contentHash: hash,
          syncedAt: new Date(),
        };
        await db
          .insert(pvMerchOrdersTable)
          .values(row)
          .onConflictDoUpdate({
            target: pvMerchOrdersTable.printavoId,
            set: {
              visualId: row.visualId,
              storePrintavoId: row.storePrintavoId,
              status: row.status,
              total: row.total,
              completedAt: row.completedAt,
              data: row.data,
              contentHash: row.contentHash,
              syncedAt: row.syncedAt,
            },
          });
        agg.ordersWritten += 1;
      }
      if (!orders.pageInfo.hasNextPage) break;
      orderCursor = orders.pageInfo.endCursor;
    }
  }

  logger.info({ agg }, "Merch sweep complete");
  return agg;
}
