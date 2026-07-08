import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import type { ReportFilters } from "./filters";

/**
 * Loads the filtered order dataset (with line items + imprints) into
 * memory. Reads Postgres ONLY — never the Printavo API. The full
 * 12-month window is ~3.4k orders / ~12k line items, well within
 * in-memory reach (mirrors the legacy Insights approach).
 */

export interface ReportLineItem {
  itemNumber: string | null;
  color: string | null;
  categoryName: string | null;
  brand: string | null;
  items: number;
  price: number;
}

export interface ReportImprint {
  matrixName: string | null;
  columnName: string | null;
  typeOfWork: string | null;
}

export interface ReportGroup {
  id: string;
  lineItems: ReportLineItem[];
  imprints: ReportImprint[];
}

export interface ReportOrder {
  id: string;
  visualId: number;
  orderType: string;
  statusName: string | null;
  nickname: string | null;
  customerName: string | null;
  total: number;
  qty: number;
  createdAt: string | null;
  dueAt: string | null;
  groups: ReportGroup[];
}

const ET = "America/New_York";

function orderConditions(f: ReportFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.orderType !== "all") {
    conds.push(sql`order_type = ${f.orderType}`);
  }
  if (f.statuses.length > 0) {
    const inList = sql`lower(coalesce(status_name, '')) IN (${sql.join(
      f.statuses.map((s) => sql`${s}`),
      sql`, `,
    )})`;
    conds.push(f.exclude.has("statuses") ? sql`NOT (${inList})` : inList);
  }
  if (f.createdStart) {
    conds.push(
      sql`(printavo_created_at AT TIME ZONE ${ET})::date >= ${f.createdStart}::date`,
    );
  }
  if (f.createdEnd) {
    conds.push(
      sql`(printavo_created_at AT TIME ZONE ${ET})::date <= ${f.createdEnd}::date`,
    );
  }
  if (f.dueStart) {
    conds.push(
      sql`(customer_due_at AT TIME ZONE ${ET})::date >= ${f.dueStart}::date`,
    );
  }
  if (f.dueEnd) {
    conds.push(
      sql`(customer_due_at AT TIME ZONE ${ET})::date <= ${f.dueEnd}::date`,
    );
  }
  if (f.minTotal !== null) {
    conds.push(sql`coalesce(total, 0) >= ${f.minTotal}`);
  }
  if (f.maxTotal !== null) {
    conds.push(sql`coalesce(total, 0) <= ${f.maxTotal}`);
  }
  if (f.search) {
    const like = `%${f.search}%`;
    conds.push(
      sql`(visual_id::text ILIKE ${like} OR nickname ILIKE ${like} OR customer_company ILIKE ${like} OR contact_name ILIKE ${like})`,
    );
  }
  return conds;
}

interface OrderRow {
  printavo_id: string;
  visual_id: number;
  order_type: string;
  status_name: string | null;
  nickname: string | null;
  customer_company: string | null;
  contact_name: string | null;
  total: string | null;
  printavo_created_at: string | null;
  customer_due_at: string | null;
}

interface GroupRow {
  printavo_id: string;
  order_id: string;
  position: number | null;
}

interface LineItemRow {
  group_id: string;
  item_number: string | null;
  color: string | null;
  category_name: string | null;
  brand: string | null;
  items: number;
  price: string | null;
}

interface ImprintRow {
  group_id: string;
  matrix_name: string | null;
  column_name: string | null;
  type_of_work: string | null;
}

function matchList(
  value: string | null,
  list: string[],
): boolean {
  return value !== null && list.includes(value.trim().toLowerCase());
}

/** Order-level inclusion on line-item filters: keep orders that HAVE a
 *  matching item (or, when excluded, orders with NO matching item). */
function passesItemFilters(order: ReportOrder, f: ReportFilters): boolean {
  const items = order.groups.flatMap((g) => g.lineItems);
  const checks: Array<{
    key: "brands" | "categories" | "styleNumbers" | "colors";
    field: (li: ReportLineItem) => string | null;
  }> = [
    { key: "brands", field: (li) => li.brand },
    { key: "categories", field: (li) => li.categoryName },
    { key: "styleNumbers", field: (li) => li.itemNumber },
    { key: "colors", field: (li) => li.color },
  ];
  for (const { key, field } of checks) {
    const list = f[key];
    if (list.length === 0) continue;
    const has = items.some((li) => matchList(field(li), list));
    if (f.exclude.has(key) ? has : !has) return false;
  }
  return true;
}

export async function loadReportOrders(
  f: ReportFilters,
): Promise<ReportOrder[]> {
  const conds = orderConditions(f);
  const where =
    conds.length > 0 ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;

  const orderRes = await db.execute(sql`
    SELECT printavo_id, visual_id, order_type, status_name, nickname,
           customer_company, contact_name, total,
           printavo_created_at, customer_due_at
    FROM pv_orders${where}
    ORDER BY printavo_created_at DESC NULLS LAST
  `);
  const orderRows = orderRes.rows as unknown as OrderRow[];
  if (orderRows.length === 0) return [];

  const ids = orderRows.map((r) => r.printavo_id);

  const [groupRes, liRes, impRes] = await Promise.all([
    db.execute(sql`
      SELECT printavo_id, order_id, position
      FROM pv_line_item_groups WHERE order_id = ANY(${sql.param(ids)})
      ORDER BY position ASC NULLS LAST
    `),
    db.execute(sql`
      SELECT group_id, item_number, color, category_name, brand, items, price
      FROM pv_line_items WHERE order_id = ANY(${sql.param(ids)})
    `),
    db.execute(sql`
      SELECT group_id, matrix_name, column_name, type_of_work
      FROM pv_imprints WHERE order_id = ANY(${sql.param(ids)})
    `),
  ]);

  const groupsByOrder = new Map<string, ReportGroup[]>();
  const groupById = new Map<string, ReportGroup>();
  for (const g of groupRes.rows as unknown as GroupRow[]) {
    const group: ReportGroup = { id: g.printavo_id, lineItems: [], imprints: [] };
    groupById.set(g.printavo_id, group);
    const list = groupsByOrder.get(g.order_id) ?? [];
    list.push(group);
    groupsByOrder.set(g.order_id, list);
  }
  for (const li of liRes.rows as unknown as LineItemRow[]) {
    groupById.get(li.group_id)?.lineItems.push({
      itemNumber: li.item_number,
      color: li.color,
      categoryName: li.category_name,
      brand: li.brand,
      items: li.items ?? 0,
      price: li.price === null ? 0 : Number(li.price),
    });
  }
  for (const imp of impRes.rows as unknown as ImprintRow[]) {
    groupById.get(imp.group_id)?.imprints.push({
      matrixName: imp.matrix_name,
      columnName: imp.column_name,
      typeOfWork: imp.type_of_work,
    });
  }

  const orders: ReportOrder[] = [];
  for (const r of orderRows) {
    const groups = groupsByOrder.get(r.printavo_id) ?? [];
    const qty = groups.reduce(
      (sum, g) => sum + g.lineItems.reduce((s, li) => s + li.items, 0),
      0,
    );
    const order: ReportOrder = {
      id: r.printavo_id,
      visualId: r.visual_id,
      orderType: r.order_type,
      statusName: r.status_name,
      nickname: r.nickname,
      customerName: r.customer_company?.trim() || r.contact_name?.trim() || null,
      total: r.total === null ? 0 : Number(r.total),
      qty,
      createdAt: r.printavo_created_at
        ? new Date(r.printavo_created_at).toISOString()
        : null,
      dueAt: r.customer_due_at
        ? new Date(r.customer_due_at).toISOString()
        : null,
      groups,
    };
    if (f.minQty !== null && qty < f.minQty) continue;
    if (f.maxQty !== null && qty > f.maxQty) continue;
    if (!passesItemFilters(order, f)) continue;
    orders.push(order);
  }
  return orders;
}
