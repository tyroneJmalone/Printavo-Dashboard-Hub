import { db, pvOrdersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export interface HubInvoiceSearchItem {
  id: string;
  visualId: number;
  nickname: string | null;
  customerCompany: string | null;
  statusName: string | null;
}

/**
 * Search invoices in the local pv_orders mirror by visible invoice number.
 *
 * Supports:
 *   - Exact match: q="1234" → visualId === 1234
 *   - Prefix/typeahead: q="123" → visualIds 1230-1239 etc (cast to text + LIKE)
 *
 * Returns only invoices (not quotes). The returned `id` is the internal
 * Printavo GraphQL id which callers can use to push via the Printavo client.
 */
export async function searchHubInvoices(
  q: string,
  limit = 10,
): Promise<HubInvoiceSearchItem[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return [];

  const safeLimit = Math.min(Math.max(1, limit), 20);

  const exact = Number(trimmed);

  const rows = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      visualId: pvOrdersTable.visualId,
      nickname: pvOrdersTable.nickname,
      customerCompany: pvOrdersTable.customerCompany,
      statusName: pvOrdersTable.statusName,
    })
    .from(pvOrdersTable)
    .where(
      and(
        eq(pvOrdersTable.orderType, "invoice"),
        sql`${pvOrdersTable.visualId}::text LIKE ${`${trimmed}%`}`,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${pvOrdersTable.visualId} = ${exact} THEN 0 ELSE 1 END`,
      pvOrdersTable.visualId,
    )
    .limit(safeLimit);

  return rows.map((row) => ({
    id: row.printavoId,
    visualId: row.visualId,
    nickname: row.nickname ?? null,
    customerCompany: row.customerCompany ?? null,
    statusName: row.statusName ?? null,
  }));
}
