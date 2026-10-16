import { pool } from "@workspace/db";
import { DASHBOARD_CTES, type DashboardPeriod } from "./dashboardMetrics";
import { notChipplySql } from "../chipply/matching";

export const PERFORMANCE_METRICS = ["totalOrders", "totalRevenue", "itemsDecorated", "netPayments", "newCustomers", "repeatCustomers"] as const;
export type PerformanceMetric = typeof PERFORMANCE_METRICS[number];

/** Reuse the exact aggregate populations, including conversion dedup and exclusions. */
export function dashboardDetailsSql(metric: PerformanceMetric) {
  const names = `o.printavo_id AS "orderId", o.visual_id AS "visualId", o.customer_id AS "customerId",
    coalesce(nullif(o.customer_company, ''), o.contact_name) AS "customerName",
    o.nickname, o.order_type AS "kind"`;
  let rows: string;
  if (metric === "newCustomers") {
    rows = `SELECT c.printavo_id AS id, NULL::text AS "orderId", NULL::int AS "visualId",
      c.printavo_id AS "customerId", coalesce(nullif(c.company_name, ''), c.data->'primaryContact'->>'fullName') AS "customerName", NULL::text AS nickname,
      'customer'::text AS kind, (c.printavo_created_at AT TIME ZONE 'America/New_York')::date::text AS date,
      1::float8 AS value, NULL::text AS note
      FROM pv_customers c JOIN selected_range r ON
      (c.printavo_created_at AT TIME ZONE 'America/New_York')::date BETWEEN r.start_day AND r.end_day`;
  } else if (metric === "netPayments") {
    rows = `SELECT p.printavo_id AS id, coalesce(p.order_id, o.printavo_id) AS "orderId", p.order_visual_id AS "visualId",
      o.customer_id AS "customerId", coalesce(nullif(o.customer_company, ''), o.contact_name) AS "customerName",
      o.nickname, p.typename AS kind, p.transaction_date::text AS date, p.amount::float8 AS value,
      CASE WHEN o.printavo_id IS NULL THEN 'Invoice/customer not available in synced history' END AS note
      FROM pv_payments p JOIN selected_range r ON p.transaction_date BETWEEN r.start_day AND r.end_day
      LEFT JOIN LATERAL (SELECT x.* FROM pv_orders x
        WHERE x.printavo_id = p.order_id OR (p.order_id IS NULL AND x.visual_id = p.order_visual_id)
        ORDER BY CASE WHEN x.order_type = 'invoice' THEN 0 ELSE 1 END, x.printavo_id LIMIT 1) o ON true
      WHERE NOT EXISTS (SELECT 1 FROM pv_orders shell
        WHERE (shell.printavo_id = p.order_id OR (p.order_id IS NULL AND shell.visual_id = p.order_visual_id))
        AND NOT ${notChipplySql("shell.nickname")})`;
  } else if (metric === "repeatCustomers") {
    rows = `SELECT o.printavo_id AS id, ${names}, e.created_day::text AS date, 1::float8 AS value,
      CASE WHEN e.date_estimated THEN 'Qualifying repeat order; original quote date unknown, invoice creation used as estimated chronology'
        ELSE 'Qualifying repeat order; original quote creation date' END::text AS note
      FROM repeat_orders e JOIN selected_range r ON e.created_day BETWEEN r.start_day AND r.end_day
      JOIN pv_orders o ON o.printavo_id = e.printavo_id WHERE e.customer_order_number > 1`;
  } else {
    const value = metric === "totalOrders" ? "1::float8" : metric === "totalRevenue" ? "i.total::float8"
      : "CASE WHEN i.detail_sync_state = 'complete' THEN coalesce(q.decorated_qty, 0)::float8 ELSE NULL END";
    rows = `SELECT o.printavo_id AS id, ${names}, i.created_day::text AS date, ${value} AS value,
      ${metric === "itemsDecorated" ? "CASE WHEN i.detail_sync_state <> 'complete' THEN 'Incomplete detail: quantity unknown' END" : "NULL::text"} AS note
      FROM invoice_population i JOIN selected_range r ON i.created_day BETWEEN r.start_day AND r.end_day
      JOIN pv_orders o ON o.printavo_id = i.printavo_id LEFT JOIN order_quantities q ON q.order_id = i.printavo_id`;
  }
  const valueSql = {
    totalOrders: "i.total_orders", totalRevenue: "i.total_revenue", itemsDecorated: "i.items_decorated",
    netPayments: "p.net_payments", newCustomers: "c.new_customers", repeatCustomers: "c.repeat_customers",
  }[metric];
  // Only reference the requested statistic. Joining all three forces unrelated
  // payment, decoration and full repeat-history calculations on every drilldown.
  const statsJoin = metric === "netPayments" ? "payment_stats p"
    : metric === "newCustomers" || metric === "repeatCustomers" ? "customer_stats c"
    : "invoice_stats i";
  return `${DASHBOARD_CTES},
    selected_range AS (SELECT * FROM ranges WHERE key = $1),
    detail_rows AS (${rows})
    SELECT r.start_day::text AS start, r.end_day::text AS end, ${valueSql}::float8 AS value,
      (SELECT count(*)::int FROM detail_rows) AS total,
      coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.date DESC, page.id) FROM (
        SELECT * FROM detail_rows ORDER BY date DESC, id LIMIT $2 OFFSET $3
      ) page), '[]'::jsonb) AS items
    FROM selected_range r JOIN ${statsJoin} USING (key)`;
}

export async function getDashboardDetails(metric: PerformanceMetric, period: DashboardPeriod, offset: number) {
  const { rows } = await pool.query(dashboardDetailsSql(metric), [period, 50, offset]);
  if (!rows[0]) throw new Error("Dashboard detail range unavailable");
  return { ...rows[0], metric, period, offset, limit: 50 };
}
