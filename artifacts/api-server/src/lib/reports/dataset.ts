import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import type { ReportFilters } from "./filters";
import { notChipplySql } from "../chipply/matching";
import {
  emptyActivityBreakdown,
  type ActivityBreakdown,
} from "./activity";
import { activityCategorySql, qualifyingActivitySql } from "./activitySql";

/**
 * Loads the filtered order dataset (with line items + imprints) into
 * memory. Reads Postgres ONLY — never the Printavo API. The full
 * 12-month window is ~3.4k orders / ~12k line items, well within
 * in-memory reach (mirrors the legacy Insights approach).
 */

export interface ReportLineItem {
  description?: string | null;
  priceKnown?: boolean;
  itemNumber: string | null;
  color: string | null;
  categoryName: string | null;
  brand: string | null;
  items: number;
  price: number;
}

export interface ReportImprint {
  id?: string;
  details?: string | null;
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
  productionMerch?: boolean;
  detailSyncState?: string | null;
  id: string;
  visualId: number;
  orderType: string;
  ownerEmail: string | null;
  statusName: string | null;
  nickname: string | null;
  customerName: string | null;
  total: number;
  qty: number;
  createdAt: string | null;
  invoiceAt: string | null;
  productionDueAt: string | null;
  dueAt: string | null;
  activityCount: number;
  latestActivityAt: string | null;
  activityBreakdown: ActivityBreakdown;
  groups: ReportGroup[];
}

const ET = "America/New_York";

/** Only production reporting may opt in to Merch; financial reports keep their
 * existing shell-invoice exclusion. Merch is classified at invoice grain. */
export const productionMerchSql = sql`(
  coalesce(nickname ~ '^\\d{5,7}\\s', false) OR coalesce(status_name ~* '\\mmerch\\M', false)
  OR EXISTS (SELECT 1 FROM pv_line_item_groups pg JOIN pv_line_items li ON li.group_id = pg.printavo_id
             WHERE pg.order_id = pv_orders.printavo_id AND li.merch = true)
  OR EXISTS (SELECT 1 FROM change_events ce WHERE ce.entity_type = 'order' AND ce.entity_id = pv_orders.printavo_id
             AND ce.event_type = 'status_change' AND ce.new_value #>> '{}' ~* '\\mmerch\\M')
)`;

function orderConditions(f: ReportFilters, includeMerch = false): SQL[] {
  const conds: SQL[] = includeMerch ? [] : [sql.raw(notChipplySql("nickname"))];
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
  if (f.invoiceStart) {
    conds.push(sql`invoice_at >= ${f.invoiceStart}::date`);
  }
  if (f.invoiceEnd) {
    conds.push(sql`invoice_at <= ${f.invoiceEnd}::date`);
  }
  if (f.productionDueStart) {
    conds.push(
      sql`(production_due_at AT TIME ZONE ${ET})::date >= ${f.productionDueStart}::date`,
    );
  }
  if (f.productionDueEnd) {
    conds.push(
      sql`(production_due_at AT TIME ZONE ${ET})::date <= ${f.productionDueEnd}::date`,
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

/**
 * Reduce activity to one row per order before joining the order dataset.
 * Legacy order events use entity_id as the order id and historically did not
 * populate order_id; line-item events use order_id while entity_id is the
 * line id. This shape prevents line joins from multiplying event counts.
 */
function activityFragments(f: ReportFilters): {
  cte: SQL;
  join: SQL;
  select: SQL;
  conditions: SQL[];
} {
  const requested =
    f.activityOnly ||
    f.activityStart !== null ||
    f.activityEnd !== null ||
    f.activityOwner !== null;
  if (!requested) {
    return {
      cte: sql``,
      join: sql``,
      select: sql`0::int AS activity_count,
        null::timestamptz AS latest_activity_at,
        jsonb_build_object(
          'quantity', 0,
          'lineItem', 0,
          'price', 0,
          'balance', 0,
          'status', 0,
          'order', 0
        ) AS activity_breakdown`,
      conditions: [],
    };
  }

  const activityDates: SQL[] = [];
  if (f.activityStart) {
    activityDates.push(
      sql`(ce.occurred_at AT TIME ZONE ${ET})::date >= ${f.activityStart}::date`,
    );
  }
  if (f.activityEnd) {
    activityDates.push(
      sql`(ce.occurred_at AT TIME ZONE ${ET})::date <= ${f.activityEnd}::date`,
    );
  }
  const activityWhere = activityDates.length
    ? sql` AND ${sql.join(activityDates, sql` AND `)}`
    : sql``;
  const cte = sql`
    WITH activity_events AS (
      SELECT CASE
        WHEN ce.entity_type = 'order' THEN ce.entity_id
        ELSE ce.order_id
      END AS order_id,
      ce.occurred_at,
      ce.entity_type,
      ce.event_type,
      ce.field,
      ${activityCategorySql(
        sql`ce.entity_type`,
        sql`ce.event_type`,
        sql`ce.field`,
      )} AS category
      FROM change_events ce
      WHERE ${qualifyingActivitySql(
        sql`ce.entity_type`,
        sql`ce.event_type`,
        sql`ce.entity_id`,
        sql`ce.order_id`,
      )}${activityWhere}
    ),
    activity_by_order AS (
      SELECT order_id, count(*)::int AS activity_count,
             max(occurred_at) AS latest_activity_at,
             jsonb_build_object(
               'quantity', count(*) FILTER (WHERE category = 'quantity')::int,
               'lineItem', count(*) FILTER (WHERE category = 'lineItem')::int,
               'price', count(*) FILTER (WHERE category = 'price')::int,
               'balance', count(*) FILTER (WHERE category = 'balance')::int,
               'status', count(*) FILTER (WHERE category = 'status')::int,
               'order', count(*) FILTER (WHERE category = 'order')::int
             ) AS activity_breakdown
      FROM activity_events
      GROUP BY order_id
    )
  `;
  const conditions: SQL[] = [];
  if (f.activityOnly) {
    conditions.push(sql`activity.order_id IS NOT NULL`);
  }
  // Ownership is qualified against the current pv_orders row, never against
  // event actor metadata or a historical owner value.
  if (f.activityOwner) {
    conditions.push(
      sql`lower(trim(coalesce(owner_email, ''))) = ${f.activityOwner.trim().toLowerCase()}`,
    );
  }
  return {
    cte,
    join: sql` LEFT JOIN activity_by_order activity
      ON activity.order_id = pv_orders.printavo_id`,
    select: sql`coalesce(activity.activity_count, 0)::int AS activity_count,
      activity.latest_activity_at,
      coalesce(
        activity.activity_breakdown,
        jsonb_build_object(
          'quantity', 0,
          'lineItem', 0,
          'price', 0,
          'balance', 0,
          'status', 0,
          'order', 0
        )
      ) AS activity_breakdown`,
    conditions,
  };
}

interface OrderRow {
  detail_sync_state: string | null;
  printavo_id: string;
  visual_id: number;
  order_type: string;
  status_name: string | null;
  nickname: string | null;
  customer_company: string | null;
  contact_name: string | null;
  total: string | null;
  owner_email: string | null;
  printavo_created_at: string | null;
  invoice_at: string | null;
  production_due_at: string | null;
  customer_due_at: string | null;
  activity_count: number | string | null;
  latest_activity_at: string | Date | null;
  activity_breakdown: ActivityBreakdown | null;
}

interface GroupRow {
  printavo_id: string;
  order_id: string;
  position: number | null;
}

interface LineItemRow {
  description: string | null;
  group_id: string;
  item_number: string | null;
  color: string | null;
  category_name: string | null;
  brand: string | null;
  items: number;
  price: string | null;
}

interface ImprintRow {
  printavo_id: string;
  details: string | null;
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
  options: { includeMerch?: boolean; classifyMerch?: boolean; orderIds?: string[] } = {},
): Promise<ReportOrder[]> {
  if (options.orderIds?.length === 0) return [];
  const activity = activityFragments(f);
  const conds = [...orderConditions(f, options.includeMerch), ...activity.conditions];
  if (options.orderIds) conds.push(sql`printavo_id IN (${sql.join(options.orderIds.map(id => sql`${id}`), sql`, `)})`);
  const where =
    conds.length > 0
      ? sql` WHERE ${sql.join(conds, sql` AND `)}`
      : sql``;

  const orderRes = await db.execute(sql`
    ${activity.cte}
    SELECT printavo_id, visual_id, order_type, status_name, nickname,
           ${options.includeMerch && options.classifyMerch !== false ? productionMerchSql : sql`false`} AS production_merch,
           customer_company, contact_name, total, detail_sync_state,
           owner_email, printavo_created_at, invoice_at, production_due_at,
           customer_due_at,
           ${activity.select}
    FROM pv_orders${activity.join}${where}
     ORDER BY printavo_created_at DESC NULLS LAST,
              visual_id DESC NULLS LAST,
              printavo_id DESC
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
      SELECT group_id, item_number, color, category_name, brand, items, price, description
      FROM pv_line_items WHERE order_id = ANY(${sql.param(ids)})
    `),
    db.execute(sql`
      SELECT printavo_id, group_id, matrix_name, column_name, type_of_work, details
      FROM pv_imprints WHERE order_id = ANY(${sql.param(ids)})
      ORDER BY printavo_id
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
      description: li.description,
      priceKnown: li.price !== null,
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
      id: imp.printavo_id,
      details: imp.details,
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
      productionMerch: Boolean((r as OrderRow & { production_merch: boolean }).production_merch),
      detailSyncState: r.detail_sync_state,
      id: r.printavo_id,
      visualId: r.visual_id,
      orderType: r.order_type,
      ownerEmail: r.owner_email,
      statusName: r.status_name,
      nickname: r.nickname,
      customerName: r.customer_company?.trim() || r.contact_name?.trim() || null,
      total: r.total === null ? 0 : Number(r.total),
      qty,
      createdAt: r.printavo_created_at
        ? new Date(r.printavo_created_at).toISOString()
        : null,
      invoiceAt: r.invoice_at,
      productionDueAt: r.production_due_at
        ? new Date(r.production_due_at).toISOString()
        : null,
      dueAt: r.customer_due_at
        ? new Date(r.customer_due_at).toISOString()
        : null,
      activityCount: Number(r.activity_count ?? 0),
      latestActivityAt: r.latest_activity_at
        ? new Date(r.latest_activity_at).toISOString()
        : null,
      activityBreakdown: r.activity_breakdown ?? emptyActivityBreakdown(),
      groups,
    };
    if (f.minQty !== null && qty < f.minQty) continue;
    if (f.maxQty !== null && qty > f.maxQty) continue;
    if (!passesItemFilters(order, f)) continue;
    orders.push(order);
  }
  return orders;
}
