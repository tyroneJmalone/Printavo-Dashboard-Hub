import { pool } from "@workspace/db";
import { notChipplySql } from "../chipply/matching";
import { pipelineStageSql } from "../../routes/pipeline";

export const PERIOD_KEYS = ["today", "yesterday", "wtd", "lw", "mtd", "lm", "qtd", "lq", "ytd", "ly"] as const;
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
    yesterday: iso(new Date(Date.UTC(year, month, day.getUTCDate() - 1))),
    wtd: iso(week),
    lw: iso(new Date(week.valueOf() - 7 * 86400000)),
    mtd: iso(new Date(Date.UTC(year, month, 1))),
    lm: iso(new Date(Date.UTC(year, month - 1, 1))),
    qtd: iso(new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1))),
    lq: iso(new Date(Date.UTC(year, Math.floor(month / 3) * 3 - 3, 1))),
    ytd: iso(new Date(Date.UTC(year, 0, 1))),
    ly: iso(new Date(Date.UTC(year - 1, 0, 1))),
  };
}

export function periodRanges(today: string) {
  const starts = periodBounds(today);
  const preceding = (date: string) => new Date(new Date(`${date}T00:00:00Z`).valueOf() - 86400000).toISOString().slice(0, 10);
  const ends: Partial<Record<DashboardPeriod, string>> = {
    yesterday: starts.yesterday, lw: preceding(starts.wtd), lm: preceding(starts.mtd),
    lq: preceding(starts.qtd), ly: preceding(starts.ytd),
  };
  return Object.fromEntries(PERIOD_KEYS.map(key => [key, {
    start: starts[key], end: ends[key] ?? today,
  }])) as Record<DashboardPeriod, { start: string; end: string }>;
}

// Canonical Purchasing normalization: normalize hyphens and collapse whitespace.
const CATEGORY_SQL = "lower(trim(regexp_replace(regexp_replace(coalesce(li.category_name, ''), '[‐‑‒–—―]', '-', 'g'), '\\s+', ' ', 'g')))";

export const DASHBOARD_CTES = `
WITH calendar AS (
  SELECT (now() AT TIME ZONE 'America/New_York')::date AS today
), bounds AS (
  SELECT today, date_trunc('week', today::timestamp)::date AS wtd,
    date_trunc('week', today::timestamp)::date - 7 AS lw,
    date_trunc('month', today::timestamp)::date AS mtd,
    date_trunc('quarter', today::timestamp)::date AS qtd,
    date_trunc('year', today::timestamp)::date AS ytd,
    (date_trunc('year', today::timestamp) - interval '1 year')::date AS ly,
    today - 6 AS recent_start
  FROM calendar
), conversions AS (
  SELECT o.printavo_id, e.occurred_at AS conversion_observed_at,
    (e.old_value->>'quoteCreatedAt')::timestamptz AS quote_created_at
  FROM change_events e JOIN pv_orders o
    ON o.printavo_id = e.new_value->>'printavoId'
    AND o.printavo_id = e.entity_id AND o.visual_id = e.visual_id
  WHERE e.entity_type = 'order' AND e.event_type = 'converted'
    AND e.old_value->>'orderType' = 'quote' AND o.order_type = 'invoice'
    AND e.old_value->>'quoteHistoryVersion' = '1'
    AND e.old_value->>'customerId' = o.customer_id
    AND e.old_value->>'quoteCreatedAt' IS NOT NULL
    AND ${notChipplySql("o.nickname")}
), surviving_quote_dates AS (
  SELECT p.customer_id, p.visual_id, min(p.printavo_created_at) AS original_date
  FROM pv_orders p WHERE p.order_type = 'quote'
  GROUP BY p.customer_id, p.visual_id
), converted_quote_dates AS (
  SELECT printavo_id, min(quote_created_at) AS original_date
  FROM conversions GROUP BY printavo_id
), original_dates AS (
  SELECT o.printavo_id,
    coalesce(q.original_date, e.original_date, o.printavo_created_at) AS chronology_at,
    o.order_type = 'invoice' AND q.original_date IS NULL AND e.original_date IS NULL AS date_estimated
  FROM pv_orders o
  LEFT JOIN surviving_quote_dates q
    ON q.customer_id = o.customer_id AND q.visual_id = o.visual_id
  LEFT JOIN converted_quote_dates e ON e.printavo_id = o.printavo_id
), eligible AS (
  SELECT o.printavo_id, o.visual_id, o.customer_id, o.order_type, o.printavo_created_at,
    d.chronology_at, d.date_estimated,
    (d.chronology_at AT TIME ZONE 'America/New_York')::date AS created_day
  FROM pv_orders o JOIN original_dates d USING (printavo_id)
  WHERE o.order_type IN ('quote', 'invoice')
    AND o.customer_id IS NOT NULL
    AND d.chronology_at IS NOT NULL
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
      BETWEEN least(b.lw, b.ly) AND b.today
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
), customer_history AS (
  -- Fixed business cohort, not a rolling first/repeat-order ranking.
  SELECT customer_id, bool_or(order_type = 'invoice' AND created_day < DATE '2026-01-01') AS is_repeat
  FROM logical_orders GROUP BY customer_id
), ranges AS (
  SELECT 'today' AS key, today AS start_day, today AS end_day FROM bounds
  UNION ALL SELECT 'yesterday', today - 1, today - 1 FROM bounds
  UNION ALL SELECT 'wtd', wtd, today FROM bounds
  UNION ALL SELECT 'lw', lw, wtd - 1 FROM bounds
  UNION ALL SELECT 'mtd', mtd, today FROM bounds
  UNION ALL SELECT 'lm', (mtd - interval '1 month')::date, mtd - 1 FROM bounds
  UNION ALL SELECT 'qtd', qtd, today FROM bounds
  UNION ALL SELECT 'lq', (qtd - interval '3 months')::date, qtd - 1 FROM bounds
  UNION ALL SELECT 'ytd', ytd, today FROM bounds
  UNION ALL SELECT 'ly', ly, ytd - 1 FROM bounds
), invoice_stats AS (
  SELECT r.key, count(i.printavo_id)::int AS total_orders,
    coalesce(sum(i.total), 0)::float8 AS total_revenue,
    CASE WHEN count(i.printavo_id) FILTER (WHERE i.detail_sync_state <> 'complete') > 0
      THEN NULL ELSE coalesce(sum(q.decorated_qty), 0)::bigint::int END AS items_decorated
  FROM ranges r LEFT JOIN invoice_population i
    ON i.created_day BETWEEN r.start_day AND r.end_day
  LEFT JOIN order_quantities q ON q.order_id = i.printavo_id AND i.detail_sync_state = 'complete'
  GROUP BY r.key
), customer_cohorts AS MATERIALIZED (
  SELECT r.key, o.customer_id, h.is_repeat,
    CASE WHEN bool_or(o.order_type = 'invoice') THEN 'invoice' ELSE 'quote' END AS order_kind,
    max(o.created_day) AS latest_order_day,
    bool_or(o.date_estimated) AS date_estimated,
    (array_agg(o.printavo_id ORDER BY o.chronology_at DESC, o.printavo_id))[1] AS representative_order_id
  FROM ranges r JOIN logical_orders o ON o.created_day BETWEEN r.start_day AND r.end_day
  JOIN customer_history h ON h.customer_id = o.customer_id
  GROUP BY r.key, o.customer_id, h.is_repeat
), customer_stats AS (
  SELECT r.key,
    count(c.customer_id) FILTER (WHERE NOT c.is_repeat)::int AS new_customers,
    count(c.customer_id) FILTER (WHERE c.is_repeat)::int AS repeat_customers,
    count(c.customer_id) FILTER (WHERE NOT c.is_repeat AND c.order_kind = 'invoice')::int AS new_customer_invoices,
    count(c.customer_id) FILTER (WHERE NOT c.is_repeat AND c.order_kind = 'quote')::int AS new_customer_quotes,
    count(c.customer_id) FILTER (WHERE c.is_repeat AND c.order_kind = 'invoice')::int AS repeat_customer_invoices,
    count(c.customer_id) FILTER (WHERE c.is_repeat AND c.order_kind = 'quote')::int AS repeat_customer_quotes
  FROM ranges r LEFT JOIN customer_cohorts c USING (key)
  GROUP BY r.key
), payment_stats AS (
  SELECT r.key, coalesce(sum(p.amount), 0)::float8 AS net_payments
  FROM ranges r LEFT JOIN pv_payments p
    ON p.transaction_date BETWEEN r.start_day AND r.end_day
    AND NOT EXISTS (SELECT 1 FROM pv_orders shell
      WHERE (shell.printavo_id = p.order_id
        OR (p.order_id IS NULL AND shell.visual_id = p.order_visual_id))
        AND NOT ${notChipplySql("shell.nickname")})
  GROUP BY r.key
), average_population AS (
  -- Join quantities once before expanding periods/methods. A correlated EXISTS
  -- against the materialized quantities rescans every group for each invoice.
  SELECT i.*, q.qty, q.print, q.embroidery, q.heat
  FROM invoice_population i LEFT JOIN order_quantities q
    ON q.order_id = i.printavo_id AND i.detail_sync_state = 'complete'
), average_stats AS (
  SELECT r.key, m.method, count(i.printavo_id)::int AS orders,
    CASE WHEN count(i.printavo_id) = 0 THEN NULL
      ELSE (sum(i.total) / count(i.printavo_id))::float8 END AS average_order_value,
    CASE WHEN count(i.printavo_id) = 0 OR count(i.qty) = 0 THEN NULL
      ELSE (sum(i.qty)::numeric / count(i.qty))::float8 END AS average_order_volume,
    count(i.qty)::int AS quantity_known_orders
  FROM ranges r CROSS JOIN (VALUES ('all'), ('print'), ('embroidery'), ('heat')) m(method)
  LEFT JOIN average_population i
    ON i.created_day BETWEEN r.start_day AND r.end_day
    AND (m.method = 'all' OR (i.detail_sync_state = 'complete'
      AND CASE m.method WHEN 'print' THEN i.print
        WHEN 'embroidery' THEN i.embroidery ELSE i.heat END))
  GROUP BY r.key, m.method
), close_orders AS (
  -- Pick the current invoice before applying eligibility or date boundaries.
  -- Unknown customers must never merge with one another (or a customer ID).
  SELECT DISTINCT ON (o.customer_id, o.visual_id,
    CASE WHEN o.customer_id IS NULL THEN o.printavo_id END)
    o.*
  FROM pv_orders o
  WHERE o.order_type IN ('quote', 'invoice')
  ORDER BY o.customer_id, o.visual_id,
    CASE WHEN o.customer_id IS NULL THEN o.printavo_id END,
    CASE WHEN o.order_type = 'invoice' THEN 0 ELSE 1 END,
    o.printavo_created_at, o.printavo_id
), quote_cohorts AS (
  -- Business rule: every invoice began as a quote. Origin is known even when
  -- its original date is not. Keep fallback date allocation explicitly estimated.
  SELECT o.*, d.chronology_at AS quote_created_at, d.date_estimated
  FROM close_orders o JOIN original_dates d USING (printavo_id)
  WHERE coalesce(o.status_name, '') !~* '(merch|contract|dead|archive|reference)'
    AND ${notChipplySql("o.nickname")}
), close_stats AS (
  SELECT r.key, count(o.printavo_id)::int AS quotes,
    count(o.printavo_id) FILTER (WHERE o.order_type = 'invoice')::int AS converted,
    count(o.printavo_id) FILTER (WHERE o.date_estimated)::int AS estimated_date_orders
  FROM ranges r LEFT JOIN quote_cohorts o
    ON (o.quote_created_at AT TIME ZONE 'America/New_York')::date BETWEEN r.start_day AND r.end_day
  GROUP BY r.key
), quote_events AS (
  SELECT printavo_id, visual_id, coalesce(nullif(customer_company, ''), contact_name) AS customer_name,
    nickname, status_name, quote_created_at AS occurred_at
  FROM quote_cohorts
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
    AND (e.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN least(b.lw, b.ly) AND b.today
    AND ${pipelineStageSql("lower(regexp_replace(coalesce(e.new_value #>> '{}', ''), '\\s+', ' ', 'g'))")} IN ('won', 'done')
    AND coalesce(${pipelineStageSql("lower(regexp_replace(coalesce(e.old_value #>> '{}', ''), '\\s+', ' ', 'g'))")}, 'other') NOT IN ('won', 'done')
  ORDER BY o.customer_id, o.visual_id, e.occurred_at, e.id
), recent AS (
  SELECT 'quotesCreated' AS kind, q.* FROM quote_events q
  UNION ALL SELECT 'dealsWon', w.* FROM won_events w
), ranked_recent AS (
  SELECT *, row_number() OVER (PARTITION BY kind ORDER BY occurred_at DESC, visual_id DESC, printavo_id) AS rank
  FROM recent CROSS JOIN bounds b
  WHERE (occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN b.recent_start AND b.today
), activity_ranked AS (
  SELECT r.key, a.*, row_number() OVER (PARTITION BY r.key, a.kind
    ORDER BY occurred_at DESC, visual_id DESC, printavo_id) AS rank,
    count(*) OVER (PARTITION BY r.key, a.kind)::int AS total
  FROM ranges r JOIN recent a
    ON (a.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN r.start_day AND r.end_day
), activity_lists AS (
  SELECT r.key, k.kind, jsonb_build_object(
    'total', coalesce(max(a.total), 0), 'truncated', coalesce(max(a.total), 0) > 12,
    'items', coalesce(jsonb_agg(jsonb_build_object('orderId', a.printavo_id,
      'visualId', a.visual_id, 'customerName', a.customer_name, 'nickname', a.nickname,
      'statusName', a.status_name, 'occurredAt', a.occurred_at)
      ORDER BY a.occurred_at DESC, a.visual_id DESC, a.printavo_id)
      FILTER (WHERE a.rank <= 12), '[]'::jsonb)) AS list
  FROM ranges r CROSS JOIN (VALUES ('quotesCreated'), ('dealsWon')) k(kind)
  LEFT JOIN activity_ranked a ON a.key = r.key AND a.kind = k.kind
  GROUP BY r.key, k.kind
)
`;

export const DASHBOARD_SQL = `${DASHBOARD_CTES}
SELECT (SELECT today::text FROM bounds) AS as_of,
  (SELECT min(conversion_observed_at) FROM conversions) AS quote_history_from,
  (SELECT count(*)::int FROM quote_cohorts WHERE date_estimated) AS unknown_quote_dates,
  (SELECT count(*)::int FROM quote_cohorts WHERE quote_created_at IS NULL) AS missing_quote_dates,
  (SELECT jsonb_object_agg(key, lists) FROM (
    SELECT key, jsonb_object_agg(kind, list) AS lists FROM activity_lists GROUP BY key
  ) a) AS activity,
  (SELECT jsonb_object_agg(key, jsonb_build_object(
    'quotes', quotes, 'converted', converted,
    'percentage', CASE WHEN quotes = 0 THEN NULL ELSE (100.0 * converted / quotes)::float8 END,
    'coverageComplete', true,
    'estimatedDateOrders', estimated_date_orders,
    'note', 'Every invoice starts as a quote. Cohorts use retained original quote dates when available; otherwise invoice Printavo createdAt is an estimated period allocation, not a verified original quote date. Current synced mirror only; missing dates are omitted and historical completeness is not asserted. Customer + visual ID is a logical-order heuristic; invoices take priority and unknown customers remain separate.'
  )) FROM close_stats) AS close_rate,
  (SELECT recent_start::text FROM bounds) AS recent_start,
  (SELECT jsonb_object_agg(i.key, jsonb_build_object(
    'start', r.start_day::text, 'end', r.end_day::text,
    'totalOrders', i.total_orders, 'totalRevenue', i.total_revenue,
    'itemsDecorated', i.items_decorated, 'netPayments', p.net_payments,
    'newCustomers', c.new_customers, 'repeatCustomers', c.repeat_customers,
    'newCustomerInvoices', c.new_customer_invoices, 'newCustomerQuotes', c.new_customer_quotes,
    'repeatCustomerInvoices', c.repeat_customer_invoices, 'repeatCustomerQuotes', c.repeat_customer_quotes
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
    activity: row.activity,
    closeRate: row.close_rate,
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
      newCustomers: "Distinct customer accounts with qualifying quote/invoice orders in the selected period and no qualifying invoice before January 1, 2026 (Eastern) in synced history. Prior unconverted quotes do not establish Repeat history. Account creation date and number of orders do not change the cohort. Count once per period; an invoice takes priority over quotes-only. Excludes ARCHIVE, DUPLICATED, REFERENCE statuses and Chipply shells. Uses original quote dates when retained, otherwise estimated invoice creation dates; missing history can affect classification.",
      repeatCustomers: "Distinct customer accounts with qualifying quote/invoice orders in the selected period and at least one qualifying invoice before the fixed January 1, 2026 (Eastern) cutoff. Prior unconverted quotes do not establish Repeat history. Count each account once regardless of order count. Invoice takes priority over quotes-only within each period; not proof of payment. Same exclusions and original-date/estimated-date rules as New Customers. Synced history may be incomplete.",
      averages: "Invoices created in period; method matched against canonical Purchasing line-item categories. Mixed-method invoices can appear in multiple method selections. Value uses whole tax-inclusive invoice total; volume averages known mirrored line-item quantities per order only. Null means no eligible denominator.",
      quotesCreated: "Total eligible quotes including those now invoiced, using the same population and Eastern cohort date as Close Rate. Retained original quote dates take priority; invoice createdAt is an explicitly estimated fallback. Customer + visual ID deduplicated with invoice priority; unknown customers remain separate.",
      closeRate: "Converted to invoices divided by total eligible quotes including converted quotes, per the business rule that every invoice begins as a quote. Cohort date is surviving quote creation, then versioned original quote history, then current Printavo createdAt as an estimated fallback for invoices. Current status need not be won. Both populations exclude statuses containing Merch, Contract, Dead, Archive or Reference case-insensitively and Chipply shells. Zero denominator yields null; no conversions yields zero. estimatedDateOrders counts invoices allocated by fallback date; coverageComplete means the mirror calculation is available, not complete historical coverage.",
      dealsWon: "First observed status transition from outside won/done into pipeline won/done for each customer + visual ID in the reporting horizon. Activity uses the selected Eastern period; legacy recent uses the last 7 days. Observation time is sync poll time, not the Printavo status-change time.",
    },
    coverage: {
      orders: "Synced Printavo mirror only; historical seed is limited, so history before the seed is unknown. New/Repeat Customer are distinct account cohorts using the fixed January 1, 2026 Eastern cutoff, not account creation dates or order counts. Qualifying quote and invoice history uses retained original quote dates when available. Legacy invoice creation dates remain estimated and may affect cohort classification.",
      quotesCreated: `Includes all eligible current quotes and invoices (every invoice began as a quote). Original dates use surviving quotes or versioned conversion snapshots; other invoices use stored Printavo createdAt as an estimated period allocation. Earliest retained dated conversion observation: ${row.quote_history_from instanceof Date ? row.quote_history_from.toISOString() : row.quote_history_from ?? "none"}. This is evidence coverage, not a quote creation date or a guarantee of continuous history. ${row.unknown_quote_dates} eligible invoices have unknown original quote dates; ${row.missing_quote_dates} logical orders lack any usable date and are omitted from periods. Historical completeness is unknown.`,
      dealsWon: "Only status changes observed by sync; seed/current states without a recorded transition are excluded.",
      statusHistoryFrom: row.status_history_from instanceof Date
        ? row.status_history_from.toISOString() : row.status_history_from ?? null,
      quantity: "Only complete detail in the mirror; orders without complete detail have unknown volume.",
    },
  };
}