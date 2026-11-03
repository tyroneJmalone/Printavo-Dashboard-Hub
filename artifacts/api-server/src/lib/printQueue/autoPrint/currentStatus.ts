import { pool } from "@workspace/db";

export interface CurrentEvidence {
  visualId: string; jobId: string; runId: string; kind: string; status: string;
  message: string | null; occurredAt: Date | string; monitor: {
    state?: string; message?: string; observedAt?: string; checkedAt?: string;
  } | null;
}
export type CurrentDetail = {
  status: string; label: string; message: string; occurredAt: string; runId: string; jobId: string;
};
export function describeCurrentEvidence(row: CurrentEvidence): CurrentDetail {
  const monitor = row.monitor;
  let status = "NEEDS REVIEW";
  let message = row.message || row.status.replaceAll("_", " ");
  if (["error", "expired"].includes(monitor?.state ?? "")) {
    status = "FAILED"; message = `PrintNode ${monitor!.state}: ${monitor?.message || "Check PrintNode and the printer before resending."}`;
  } else if (["submission_unknown", "held", "review_required", "blocked"].includes(row.status) ||
    monitor?.state === "unavailable" || (row.status === "printed" && !!row.message)) {
    message = monitor?.state === "unavailable" ? "PrintNode status monitoring is unavailable; outcome is unconfirmed." : message;
  } else if (["failed", "exhausted"].includes(row.status)) status = "FAILED";
  else if (["pending", "retry_pending", "applying", "status_queued"].includes(row.status)) status = "PENDING";
  else if (row.status === "printed") {
    status = monitor?.state && monitor.state !== "done" ? "PENDING" : "SUCCESS";
    message = monitor?.state === "done" ? "Delivered to the computer’s print queue; physical paper output is not confirmed."
      : monitor?.state ? `Accepted by PrintNode; latest state: ${monitor.state}.`
      : "Accepted by PrintNode; downstream status has not been recorded. Physical paper output is not confirmed.";
  } else if (row.status === "cancelled") status = "CANCELLED";
  else if (row.status === "dry_run") status = "SIMULATED";
  else if (row.status === "skipped") status = "SKIPPED";
  else if (["updated", "noop"].includes(row.status)) status = "SUCCESS";
  return {
    status, label: row.kind.replaceAll("_", " "), message,
    occurredAt: new Date(monitor?.observedAt ?? row.occurredAt).toISOString(),
    runId: row.runId, jobId: row.jobId,
  };
}

const priority = ["FAILED", "NEEDS REVIEW", "PENDING", "CANCELLED", "SKIPPED", "SIMULATED", "SUCCESS"];
export function currentStatusFromRows(rows: CurrentEvidence[]) {
  const details = rows.map(describeCurrentEvidence);
  const status = priority.find(s => details.some(d => d.status === s)) ?? "NO HISTORY";
  const relevant = details.filter(d => d.status === status);
  const occurredAt = relevant.map(d => d.occurredAt).sort().at(-1) ?? null;
  return { status, occurredAt, details, summary: details.length
    ? "Latest recorded outcome per document stream, plus active correction holds. Older attempts and routine skips remain in history. Success means accepted submission, not confirmed paper output."
    : "No saved AutoPrint outcome for this invoice." };
}

/** Read all relevant streams independently of the paginated history. Routine
 * duplicate skips and simulations must not hide the last live print outcome. */
export const currentStatusSql = `
WITH ranked AS (
 SELECT j.*, row_number() OVER (
   PARTITION BY visual_id,doc_type,coalesce(hub_po_id::text,'')
   ORDER BY CASE WHEN status IN ('skipped','dry_run') THEN 1 ELSE 0 END,
     created_at DESC,id DESC) AS rank
 FROM pq_print_jobs j WHERE visual_id=ANY($1::text[])
), evidence AS (
 SELECT j.visual_id AS "visualId",j.id::text AS "jobId",j.run_id::text AS "runId",
   j.doc_type AS kind,j.status,j.error_message AS message,
   coalesce(a.at,j.printed_at,j.created_at) AS "occurredAt",
   j.snapshot_metadata->'printNodeMonitor' AS monitor
 FROM ranked j LEFT JOIN LATERAL (
   SELECT coalesce(finished_at,started_at) AS at FROM pq_print_attempts
   WHERE job_id=j.id ORDER BY started_at DESC LIMIT 1
 ) a ON true WHERE rank=1
 UNION ALL
 SELECT i->>'visualId',i->>'jobId',p.value->>'runId','status_category_correction',
   i->>'state',i->>'message',p.updated_at,NULL::jsonb
 FROM app_settings p CROSS JOIN LATERAL jsonb_array_elements(p.value->'invoices') i
 WHERE p.key LIKE 'autoprint.followup.preview:%' AND i->>'visualId'=ANY($1::text[])
   AND EXISTS (SELECT 1 FROM app_settings h
     WHERE h.key='autoprint.followup.invoice:'||(i->>'orderId')
       AND h.value->>'previewId'=p.value->>'previewId')
   AND i->>'state' IN ('review_required','blocked','applying','status_queued')
) SELECT * FROM evidence ORDER BY "occurredAt" DESC`;

export async function currentInvoiceStatuses(invoices: string[]) {
  const { rows } = await pool.query<CurrentEvidence>(currentStatusSql, [invoices]);
  return new Map(invoices.map(invoice => [invoice, currentStatusFromRows(rows.filter(r => r.visualId === invoice))]));
}
