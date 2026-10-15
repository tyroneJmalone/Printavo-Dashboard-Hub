import { pool } from "@workspace/db";
import type { WindowFilter } from "./workspace";
import { notChipplySql } from "../chipply/matching";

/** SQL owns date filtering and grouping. Current quotes are context, not proof of a repeat order. */
export async function salesHistory(filter: WindowFilter & { dateBasis?: string; offset: number }) {
  const date = filter.dateBasis === "customerDue" ? "(o.customer_due_at AT TIME ZONE 'UTC')::date" : "o.invoice_at";
  const params = [filter.from, filter.to, filter.customerId ?? null, filter.owner ?? null, filter.nicheId ?? null, filter.offset];
  const r = await pool.query(`
    WITH matched AS (
      SELECT o.*,${date} AS match_date FROM pv_orders o
      LEFT JOIN customer_meta cm ON cm.printavo_customer_id=o.customer_id
      WHERE o.order_type='invoice' AND ${notChipplySql("o.nickname")}
        AND ${date} BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR o.customer_id=$3)
        AND ($4::text IS NULL OR lower(o.owner_email)=$4)
        AND ($5::uuid IS NULL OR cm.category_id=$5)
    ), clients AS (
      SELECT customer_id,max(match_date) AS last_match FROM matched WHERE customer_id IS NOT NULL
      GROUP BY customer_id ORDER BY last_match DESC,customer_id LIMIT 51 OFFSET $6
    )
    SELECT c.printavo_id AS "customerId",
      coalesce(nullif(c.company_name,''),c.data->'primaryContact'->>'fullName','(no name)') AS name,
      cc.name AS niche,
      (SELECT max(invoice_at)::text FROM pv_orders o WHERE o.customer_id=c.printavo_id AND o.order_type='invoice' AND ${notChipplySql("o.nickname")}) AS "latestOrderDate",
      (SELECT count(*)::int FROM pv_orders o WHERE o.customer_id=c.printavo_id AND o.order_type='quote'
        AND coalesce(o.status_name,'') !~* '(cancel|declin|(^|[^a-z])(dead|lost|archive|archived)([^a-z]|$))'
        AND NOT EXISTS (SELECT 1 FROM pv_orders converted WHERE converted.order_type='invoice' AND converted.visual_id=o.visual_id)
        AND ${notChipplySql("o.nickname")}) AS "activeQuoteCount",
      (SELECT jsonb_agg(jsonb_build_object('id',m.printavo_id,'number',m.visual_id,'nickname',m.nickname,
        'date',m.match_date::text,'total',coalesce(m.total,0),'owner',m.owner_email,
        'quantity',(SELECT coalesce(sum(li.items),0) FROM pv_line_items li WHERE li.order_id=m.printavo_id))
        ORDER BY m.match_date DESC,m.printavo_id) FROM matched m WHERE m.customer_id=c.printavo_id) AS invoices
    FROM clients x JOIN pv_customers c ON c.printavo_id=x.customer_id
    LEFT JOIN customer_meta cm ON cm.printavo_customer_id=c.printavo_id
    LEFT JOIN customer_categories cc ON cc.id=cm.category_id
    ORDER BY x.last_match DESC,x.customer_id`, params);
  return { customers: r.rows.slice(0, 50), hasMore: r.rows.length > 50 };
}
