import { db, pvOrdersTable, pvLineItemsTable } from "@workspace/db";
import { eq, desc, inArray, sql } from "drizzle-orm";

/**
 * Print Queue manual mode — order list (PQ1).
 *
 * Reads Postgres ONLY (pv_orders + pv_line_items); never touches the
 * Printavo API. Quantity is a nullable LEFT JOIN sum because line-item
 * detail sync may lag behind the order list sync on some orders.
 */

export interface PrintQueueOrderRow {
  printavoId: string;
  visualId: number;
  orderType: string;
  nickname: string | null;
  contactName: string | null;
  customerCompany: string | null;
  total: string | null;
  quantity: number | null;
  statusId: string | null;
  statusName: string | null;
  productionDueAt: string | null;
  customerDueAt: string | null;
  hasWorkorder: boolean;
}

export async function listPrintQueueOrders(
  statusIds: string[],
): Promise<PrintQueueOrderRow[]> {
  const li = db
    .select({
      orderId: pvLineItemsTable.orderId,
      qty: sql<string | null>`sum(${pvLineItemsTable.items})`.as("qty"),
    })
    .from(pvLineItemsTable)
    .groupBy(pvLineItemsTable.orderId)
    .as("li");

  const rows = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      visualId: pvOrdersTable.visualId,
      orderType: pvOrdersTable.orderType,
      nickname: pvOrdersTable.nickname,
      contactName: pvOrdersTable.contactName,
      customerCompany: pvOrdersTable.customerCompany,
      total: pvOrdersTable.total,
      statusId: pvOrdersTable.statusId,
      statusName: pvOrdersTable.statusName,
      productionDueAt: pvOrdersTable.productionDueAt,
      customerDueAt: pvOrdersTable.customerDueAt,
      data: pvOrdersTable.data,
      qty: li.qty,
    })
    .from(pvOrdersTable)
    .leftJoin(li, eq(li.orderId, pvOrdersTable.printavoId))
    .where(inArray(pvOrdersTable.statusId, statusIds))
    .orderBy(desc(pvOrdersTable.visualId));

  return rows.map((r) => {
    const raw = r.data as { workorderUrl?: unknown } | null;
    const hasWorkorder = typeof raw?.workorderUrl === "string" && raw.workorderUrl.length > 0;
    return {
      printavoId: r.printavoId,
      visualId: r.visualId,
      orderType: r.orderType,
      nickname: r.nickname,
      contactName: r.contactName,
      customerCompany: r.customerCompany,
      total: r.total,
      quantity: r.qty == null ? null : Number(r.qty),
      statusId: r.statusId,
      statusName: r.statusName,
      productionDueAt: r.productionDueAt ? r.productionDueAt.toISOString() : null,
      customerDueAt: r.customerDueAt ? r.customerDueAt.toISOString() : null,
      hasWorkorder,
    };
  });
}
