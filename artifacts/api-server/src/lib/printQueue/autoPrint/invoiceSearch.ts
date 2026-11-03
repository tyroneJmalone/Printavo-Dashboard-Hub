import { pool } from "@workspace/db";
import { currentInvoiceStatuses } from "./currentStatus";

/** Read-only: exact invoice lookup, including history outside recent-run/queue limits. */
export const invoiceSearchSql = `
WITH records AS (
  SELECT 'job:'||j.id AS id, j.run_id::text AS "runId", j.id::text AS "jobId",
    j.doc_type AS kind, j.status,
    coalesce(j.error_message, j.reason, '') AS message,
    coalesce(j.nickname, '') AS nickname,
    coalesce(a.started_at, j.printed_at, j.created_at) AS "occurredAt",
    CASE WHEN a.started_at IS NOT NULL THEN 'Last attempt'
      WHEN j.printed_at IS NOT NULL THEN 'Accepted'
      ELSE 'Recorded' END AS "dateLabel"
  FROM pq_print_jobs j
  LEFT JOIN LATERAL (
    SELECT started_at FROM pq_print_attempts WHERE job_id=j.id ORDER BY started_at DESC LIMIT 1
  ) a ON true
  WHERE j.visual_id=$1
  UNION ALL
  SELECT p.key||':'||(i->>'jobId'), p.value->>'runId', i->>'jobId',
    'status_category_correction', i->>'state', coalesce(i->>'message',''),
    coalesce(i->>'nickname',''), p.updated_at, 'Correction record updated'
  FROM app_settings p
  CROSS JOIN LATERAL jsonb_array_elements(p.value->'invoices') i
  WHERE p.key LIKE 'autoprint.followup.preview:%'
    AND p.value @> jsonb_build_object('invoices',jsonb_build_array(jsonb_build_object('visualId',$1::text)))
    AND i->>'visualId'=$1
)
SELECT * FROM records ORDER BY "occurredAt" DESC, id DESC LIMIT 51 OFFSET $2`;

export async function searchInvoice(invoice: string, offset: number) {
  const [{ rows }, current] = await Promise.all([
    pool.query(invoiceSearchSql, [invoice, offset]), currentInvoiceStatuses([invoice]),
  ]);
  return { items: rows.slice(0, 50), hasMore: rows.length > 50, current: current.get(invoice)! };
}
