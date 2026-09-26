import { pool } from "@workspace/db";
import { notChipplySql } from "../chipply/matching";
import { pipelineStageSql } from "../../routes/pipeline";

export const PERIOD_KEYS = ["today", "wtd", "mtd", "qtd", "ytd"] as const;
export type DashboardPeriod = typeof PERIOD_KEYS[number];
export const METHOD_KEYS = ["all", "print", "embroidery", "heat"] as const;
export type DashboardMethod = typeof METHOD_KEYS[number];

// Calendar arithmetic on dates, never 24-hour UTC intervals: Eastern DST
// changes do not move the start/end of a reporting day.
export function periodBounds(today: string): Record<DashboardPeriod, string> {
  const day = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(day.valueOf()) || day.toISOString().slice(0, 10) !== today) {
    throw new Error("Invalid calendar date");
  }
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const week = new Date(day);
  week.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth();
  return {
    today,
    wtd: iso(week),
    mtd: iso(new Date(Date.UTC(year, month, 1))),
    qtd: iso(new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1))),
    ytd: iso(new Date(Date.UTC(year, 0, 1))),
  };
}

// Canonical Purchasing normalization: normalize hyphens and collapse whitespace.
const CATEGORY_SQL = "lower(trim(regexp_replace(regexp_replace(coalesce(li.category_name, ''), '[‐‑‒–—―]', '-', 'g'), '\\s+', ' ', 'g')))";

export const DASHBOARD_SQL = `
WITH calendar AS (
  SELECT (now() AT TIME ZONE 'America/New_York')::date AS today
), bounds AS (
  SELECT today, date_trunc('week', today::timestamp)::date AS wtd,
    date_trunc('month', today::timestamp)::date AS mtd,
    date_trunc('quarter', today::timestamp)::date AS qtd,
    date_trunc('year', today::timestamp)::date AS ytd,
    today - 6 AS recent_start
  FROM calendar
), eligible AS (
  SELECT o.printavo_id, o.visual_id, o.customer_id, o.order_type, o.printavo_created_at,
    (o.printavo_created_at AT TIME ZONE 'America/New_York')::date AS created_day
  FROM pv_orders o
  WHERE o.order_type IN ('quote', 'invoice')
    AND o.customer_id IS NOT NULL
    AND o.printavo_created_at IS NOT NULL
    AND coalesce(o.status_name, '') !~* '(archive|duplicat|reference)'
    AND ${notChipplySql("o.nickname")}
), invoice_population AS (
  SELECT o.printavo_id, o.total, o.detail_sync_state,
    (o.printavo_created_at AT TIME ZONE 'America/New_York')::date AS created_day
  FROM pv_orders o CROSS JOIN bounds b
  WHERE o.order_type = 'invoice'
    AND o.printavo_created_at IS NOT NULL
    AND ${notChipplySql("o.nickname")}
    -- The Monday week may begin before Jan 1; YTD alone is not enough.
    AND (o.printavo_created_at AT TIME ZONE 'America/New_York')::date
      BETWEEN least(b.wtd, b.ytd) AND b.today
), line_groups AS (
  SELECT li.order_id, li.group_id, sum(greatest(li.items, 0))::bigint AS qty,
    bool_or(${CATEGORY_SQL} = 'screen printing') AS print,
    bool_or(${CATEGORY_SQL} IN
      ('embroidery', 'embroidery - personalizations', 'embroidery - set up/digitizing')) AS embroidery,
    bool_or(${CATEGORY_SQL} IN
      ('heat applied graphics', 'heat applied graphics - personalizations')) AS heat
  FROM pv_line_items li JOIN invoice_population i ON i.printavo_id = li.order_id
  GROUP BY li.order_id, li.group_id
), order_quantities AS (
  SELECT order_id, sum(qty)::bigint AS qty,
    coalesce(sum(qty) FILTER (WHERE print OR embroidery OR heat OR EXISTS (
      SELECT 1 FROM pv_imprints imp WHERE imp.group_id = line_groups.group_id
    )), 0)::bigint AS decorated_qty,
    bool_or(print) AS print,
    bool_or(embroidery) AS embroidery, bool_or(heat) AS heat
  FROM line_groups GROUP BY order_id
), logical_orders AS (
  -- Conversion replaces the quote in the mirror. Keep one logical order per
  -- customer/visual id, preferring the invoice where both rows survive.
  SELECT DISTINCT ON (customer_id, visual_id) *
  FROM eligible ORDER BY customer_id, visual_id,
    CASE WHEN order_type = 'invoice' THEN 0 ELSE 1 END, printavo_created_at, printavo_id
), repeat_orders AS (
  SELECT l.*, row_number() OVER (
    PARTITION BY customer_id ORDER BY printavo_created_at, visual_id, printavo_id
  ) AS customer_order_number
  FROM logical_orders l
), ranges AS (
  SELECT 'today' AS key, today AS start_day, today FROM bounds
  UNION ALL SELECT 'wtd', wtd, today FROM bounds
  UNION ALL SELECT 'mtd', mtd, today FROM bounds
  UNION ALL SELECT 'qtd', qtd, today FROM bounds
  UNION ALL SELECT 'ytd', ytd, today FROM bounds
), invoice_stats AS (
  SELECT r.key, count(i.printavo_id)::int AS total_orders,
    coalesce(sum(i.total), 0)::float8 AS total_revenue,
    CASE WHEN count(i.printavo_id) FILTER (WHERE i.detail_sync_state <> 'complete') > 0
      THEN NULL ELSE coalesce(sum(q.decorated_qty), 0)::bigint::int END AS items_decorated
  FROM ranges r LEFT JOIN invoice_population i
    ON i.created_day BETWEEN r.start_day AND r.today
  LEFT JOIN order_quantities q ON q.order_id = i.printavo_id AND i.detail_sync_state = 'complete'
  GROUP BY r.key
), customer_stats AS (
  SELECT r.key,
    (SELECT count(*)::int FROM pv_customers c
      WHERE (c.printavo_created_at AT TIME ZONE 'America/New_York')::date
        BETWEEN r.start_day AND r.today) AS new_customers,
    (SELECT count(*)::int FROM repeat_orders o
      WHERE o.customer_order_number > 1 AND o.created_day BETWEEN r.start_day AND r.today) AS repeat_customers
  FROM ranges r
), payment_stats AS (
  SELECT r.key, coalesce(sum(p.amount), 0)::float8 AS net_payments
  FROM ranges r LEFT JOIN pv_payments p
    ON p.transaction_date BETWEEN r.start_day AND r.today
    AND NOT EXISTS (SELECT 1 FROM pv_orders shell
      WHERE (shell.printavo_id = p.order_id
        OR (p.order_id IS NULL AND shell.visual_id = p.order_visual_id))
        AND NOT ${notChipplySql("shell.nickname")})
  GROUP BY r.key
), average_stats AS (
  SELECT r.key, m.method, count(i.printavo_id)::int AS orders,
    CASE WHEN count(i.printavo_id) = 0 THEN NULL
      ELSE (sum(i.total) / count(i.printavo_id))::float8 END AS average_order_value,
    CASE WHEN count(i.printavo_id) = 0 OR count(q.qty) = 0 THEN NULL
      ELSE (sum(q.qty)::numeric / count(q.qty))::float8 END AS average_order_volume,
    count(q.qty)::int AS quantity_known_orders
  FROM ranges r CROSS JOIN (VALUES ('all'), ('print'), ('embroidery'), ('heat')) m(method)
  LEFT JOIN invoice_population i
    ON i.created_day BETWEEN r.start_day AND r.today
    AND (m.method = 'all' OR (i.detail_sync_state = 'complete' AND EXISTS (
      SELECT 1 FROM order_quantities mq WHERE mq.order_id = i.printavo_id
        AND CASE m.method WHEN 'print' THEN mq.print
          WHEN 'embroidery' THEN mq.embroidery ELSE mq.heat END
    )))
  LEFT JOIN order_quantities q ON q.order_id = i.printavo_id AND i.detail_sync_state = 'complete'
  GROUP BY r.key, m.method
), quote_events AS (
  SELECT o.printavo_id, o.visual_id, coalesce(nullif(o.customer_company, ''), o.contact_name) AS customer_name,
    o.nickname, o.status_name, o.printavo_created_at AS occurred_at
  FROM pv_orders o CROSS JOIN bounds b
  WHERE o.order_type = 'quote'
    AND ${notChipplySql("o.nickname")}
    AND (o.printavo_created_at AT TIME ZONE 'America/New_York')::date BETWEEN b.recent_start AND b.today
), won_events AS (
  SELECT DISTINCT ON (o.customer_id, o.visual_id)
    o.printavo_id, o.visual_id, coalesce(nullif(o.customer_company, ''), o.contact_name) AS customer_name,
    o.nickname, o.status_name, e.occurred_at
  FROM change_events e
  JOIN pv_orders o ON o.printavo_id = e.entity_id
    OR (o.visual_id = e.visual_id AND EXISTS (
      SELECT 1 FROM change_events conversion
      WHERE conversion.entity_type = 'order' AND conversion.event_type = 'converted'
        AND conversion.old_value->>'printavoId' = e.entity_id
        AND conversion.new_value->>'printavoId' = o.printavo_id
    ))
  CROSS JOIN bounds b
  WHERE e.entity_type = 'order' AND e.event_type = 'status_change'
    AND o.order_type IN ('quote', 'invoice')
    AND ${notChipplySql("o.nickname")}
    AND (e.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN b.recent_start AND b.today
    AND ${pipelineStageSql("lower(regexp_replace(coalesce(e.new_value #>> '{}', ''), '\\s+', ' ', 'g'))")} IN ('won', 'done')
    AND coalesce(${pipelineStageSql("lower(regexp_replace(coalesce(e.old_value #>> '{}', ''), '\\s+', ' ', 'g'))")}, 'other') NOT IN ('won', 'done')
  ORDER BY o.customer_id, o.visual_id, e.occurred_at, e.id
), recent AS (
  SELECT 'quotesCreated' AS kind, q.* FROM quote_events q
  UNION ALL SELECT 'dealsWon', w.* FROM won_events w
), ranked_recent AS (
  SELECT *, row_number() OVER (PARTITION BY kind ORDER BY occurred_at DESC, visual_id DESC, printavo_id) AS rank
  FROM recent
)
SELECT (SELECT today::text FROM bounds) AS as_of,
  (SELECT recent_start::text FROM bounds) AS recent_start,
  (SELECT jsonb_object_agg(i.key, jsonb_build_object(
    'start', r.start_day::text, 'end', r.today::text,
    'totalOrders', i.total_orders, 'totalRevenue', i.total_revenue,
    'itemsDecorated', i.items_decorated, 'netPayments', p.net_payments,
    'newCustomers', c.new_customers, 'repeatCustomers', c.repeat_customers
  )) FROM invoice_stats i JOIN customer_stats c USING (key)
    JOIN payment_stats p USING (key) JOIN ranges r USING (key)) AS periods,
  (SELECT jsonb_object_agg(key, methods) FROM (
    SELECT key, jsonb_object_agg(method, jsonb_build_object(
      'orders', orders, 'averageOrderValue', average_order_value,
      'averageOrderVolume', average_order_volume, 'quantityKnownOrders', quantity_known_orders
    )) AS methods FROM average_stats GROUP BY key
  ) a) AS averages,
  (SELECT jsonb_object_agg(kind, jsonb_build_object(
    'total', total, 'truncated', total > 12, 'items', items
  )) FROM (
    SELECT kind, max(total) AS total,
      coalesce(jsonb_agg(jsonb_build_object('orderId', printavo_id,
        'visualId', visual_id, 'customerName', customer_name, 'nickname', nickname,
        'statusName', status_name, 'occurredAt', occurred_at)
        ORDER BY occurred_at DESC, visual_id DESC) FILTER (WHERE rank <= 12), '[]'::jsonb) AS items
    FROM (SELECT *, count(*) OVER (PARTITION BY kind)::int AS total FROM ranked_recent) x
    GROUP BY kind
  ) lists) AS recent,
  (SELECT min(occurred_at) FROM change_events WHERE entity_type = 'order'
    AND event_type = 'status_change') AS status_history_from
`;

export async function getDashboardMetrics() {
  const result = await pool.query(DASHBOARD_SQL);
  const row = result.rows[0];
  if (!row) throw new Error("Dashboard aggregation returned no row");
  return {
    asOf: row.as_of as string,
    timeZone: "America/New_York",
    periods: row.periods,
    averages: row.averages,
    recentStart: row.recent_start as string,
    recent: {
      quotesCreated: row.recent?.quotesCreated ?? { total: 0, truncated: false, items: [] },
      dealsWon: row.recent?.dealsWon ?? { total: 0, truncated: false, items: [] },
    },
    definitions: {
      totalOrders: "Printavo invoices created in the Eastern calendar period; Chipply shells excluded.",
      totalRevenue: "Tax-inclusive Printavo invoice total (not payment receipts); Chipply stores excluded.",
      itemsDecorated: "Sum of complete-detail invoice group line quantities only when the group has a canonical decoration category or an imprint; no multiple-imprint fanout. Null if any invoice in the period lacks complete detail.",
      netPayments: "Signed Printavo payment transaction amounts by transaction_date, excluding transactions linked to Chipply shells (unlike the broader Payments report).",
      newCustomers: "Printavo customer creation timestamp, not mirror first-seen time.",
      repeatCustomers: "Number of qualifying quote/invoice logical orders from customers with a prior qualifying logical order across synced history; not distinct customers or reorders. Statuses containing ARCHIVE, DUPLICATED or REFERENCE and Chipply shells excluded. Customer + visual ID is the conversion identity heuristic; a reused visual ID for the same customer could merge unrelated orders. A converted invoice may have a new Printavo created timestamp, so its reported period is not guaranteed to be the original quote creation period.",
      averages: "Invoices created in period; method matched against canonical Purchasing line-item categories. Mixed-method invoices can appear in multiple method selections. Value uses whole tax-inclusive invoice total; volume averages known mirrored line-item quantities per order only. Null means no eligible denominator.",
      quotesCreated: "Current unconverted quotes by Printavo creation timestamp. Converted/deleted quotes lack a trustworthy preserved quote creation timestamp in the mirror and are not included.",
      dealsWon: "First observed status transition from outside won/done into pipeline won/done for each customer + visual ID in the last 7 Eastern calendar days. Observation time is sync poll time, not the Printavo status-change time.",
    },
    coverage: {
      orders: "Synced Printavo mirror only; historical seed is limited, so repeat history before the seed is unknown. Original quote creation date is not retained when conversion replaces a quote with an invoice; repeat event periods may shift to the invoice's Printavo created date.",
      quotesCreated: "Current unconverted quotes only; converted quotes cannot be reconstructed reliably from change events.",
      dealsWon: "Only status changes observed by sync; seed/current states without a recorded transition are excluded.",
      statusHistoryFrom: row.status_history_from instanceof Date
        ? row.status_history_from.toISOString() : row.status_history_from ?? null,
      quantity: "Only complete detail in the mirror; orders without complete detail have unknown volume.",
    },
  };
}