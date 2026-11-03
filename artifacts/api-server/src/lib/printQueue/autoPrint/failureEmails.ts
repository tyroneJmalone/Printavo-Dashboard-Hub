import { createHash } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { pool, db, pqAdminAlertsTable as alerts, pqPrintJobsTable as jobs, pqPrintRunsTable as runs } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { activeAlertPredicate } from "./activeAlerts";
import { failureEmailBody, emailRetryWindowOpen, type FailureEmail } from "./emailPolicy";

const PREFIX = "autoprint.failure-email:";
const ACTIVATION = "autoprint.failure-email-started";
const RECIPIENT = "it@mintprintworks.com";

/** Read-only sources; no printer, Printavo mutation, or status-worker dependency. */
export async function emailIncidents(since: string): Promise<FailureEmail[]> {
  const active = await db.select({ id: alerts.id, eventKey: alerts.eventKey, jobId: alerts.jobId, runId: alerts.runId,
    payload: alerts.payload, error: jobs.errorMessage }).from(alerts)
    .leftJoin(jobs, eq(jobs.id, alerts.jobId)).leftJoin(runs, eq(runs.id, alerts.runId))
    .where(and(activeAlertPredicate, sql`${alerts.createdAt} >= ${since}::timestamptz`,
      sql`NOT EXISTS (SELECT 1 FROM app_settings delivery
        WHERE delivery.key = ${PREFIX} || 'alert:' || CASE WHEN ${alerts.eventKey} LIKE 'printnode:%'
          THEN ${alerts.eventKey} ELSE coalesce(${alerts.jobId}::text, ${alerts.runId}::text) END
        AND (delivery.value->>'state' IN ('sent','review_required')
          OR (delivery.value->>'nextAt')::timestamptz > now()))`,
      sql`(${alerts.eventKey} LIKE 'printnode:%' OR NOT EXISTS (SELECT 1 FROM app_settings correction
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(correction.value->'invoices','[]')) entry
        WHERE correction.key LIKE 'autoprint.followup.preview:%'
          AND entry->>'jobId' = ${alerts.jobId}::text AND entry->>'state' = 'updated'
          AND ${jobs.status} = 'printed'))`))
    .limit(25);
  const incidents: FailureEmail[] = active.map(row => {
    const p = row.payload as { title: string; reason: string; visualId: string | null; occurredAt: string };
    return { key: `alert:${row.eventKey.startsWith("printnode:") ? row.eventKey : row.jobId ?? row.runId}`, title: p.title, invoice: p.visualId,
      reason: row.eventKey.startsWith("printnode:") ? p.reason : row.error || p.reason, at: p.occurredAt };
  });
  const other = await pool.query<FailureEmail>(`
    WITH candidates AS (
      SELECT 'mapping:' || j.id AS key, 'No post-print destination/category mapping' AS title,
        j.visual_id AS invoice, j.printed_at::text AS at,
        'Workorder was accepted, but no destination rule matched and no category assignments were planned. Review the routing rules, then use Status/Category Correction; do not reprint.' AS reason
      FROM pq_print_jobs j
      JOIN pq_print_runs r ON r.id=j.run_id
      JOIN pv_orders o ON o.printavo_id=j.printavo_order_id
      WHERE j.status='printed' AND NOT r.dry_run AND j.doc_type='workorder'
        AND j.printed_at >= $1::timestamptz AND j.target_status_id IS NULL
        AND j.source_status_name ILIKE '%merch%' AND o.status_id=j.source_status_id
        AND j.snapshot_metadata->'durableRetry'->>'routingPrepared'='true'
        AND EXISTS (SELECT 1 FROM app_settings c WHERE c.key='pq_autoprint_config'
          AND c.value->>'routingMode'='conditional'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(c.value->'routingRules','[]')) rule
            WHERE rule->>'enabled'='true'))
      UNION ALL
      SELECT 'status:' || s.id || ':' || (line->>'orderId'), 'Post-print status change needs review',
        line->>'visualId', s.updated_at::text,
        coalesce(line->>'error','Status worker was interrupted before confirming the change.')
      FROM pq_status_jobs s
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.state->'lines','[]')) line
      WHERE s.trigger='autoprint' AND s.updated_at >= $1::timestamptz
        AND (line->>'status' IN ('failed','stale')
          OR (line->>'status'='pending' AND
            (s.state->>'status'='failed' OR s.updated_at < now()-interval '10 minutes')))
        AND NOT EXISTS (SELECT 1 FROM pv_orders o WHERE o.printavo_id=line->>'orderId'
          AND o.status_id=line->>'targetStatusId')
      UNION ALL
      SELECT 'correction:' || s.key || ':' || (entry->>'jobId'), 'MERCH status/category correction needs review',
        entry->>'visualId', s.updated_at::text, coalesce(entry->>'message','Correction requires review.')
      FROM app_settings s
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.value->'invoices','[]')) entry
      WHERE s.key LIKE 'autoprint.followup.preview:%' AND s.updated_at >= $1::timestamptz
        AND s.value->>'state'='complete' AND entry->>'state'='review_required'
        AND EXISTS (SELECT 1 FROM app_settings hold
          WHERE hold.key='autoprint.followup.invoice:' || (entry->>'orderId')
          AND hold.value->>'previewId'=s.value->>'previewId')
    )
    SELECT * FROM candidates c WHERE NOT EXISTS (
      SELECT 1 FROM app_settings d WHERE d.key=$2 || c.key
        AND (d.value->>'state' IN ('sent','review_required') OR (d.value->>'nextAt')::timestamptz > now())
    ) ORDER BY at LIMIT 25`, [since, PREFIX]);
  return [...incidents, ...other.rows];
}

/** Production-only, durable per-incident delivery. Each row is locked during the
 * bounded send, preventing concurrent replicas from sending separate messages.
 * Frozen payload + provider idempotency also protect lost acknowledgements. */
export async function sendAutoPrintFailureEmails(log: Logger) {
  if (process.env.NODE_ENV !== "production") return;
  await pool.query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",
    [ACTIVATION, JSON.stringify({ since: new Date().toISOString() })]);
  const activation = await pool.query("SELECT value FROM app_settings WHERE key=$1", [ACTIVATION]);
  const since = activation.rows[0].value.since;
  if (!Number.isFinite(Date.parse(since))) throw new Error("Invalid AutoPrint email activation date");
  for (const incident of await emailIncidents(since)) {
    const key = PREFIX + incident.key;
    const body = { from: `Mint Printworks Hub <${process.env.FROM_EMAIL ?? "noreply@mintprintworks.com"}>`,
      to: RECIPIENT, ...failureEmailBody(incident) };
    await pool.query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",
      [key, JSON.stringify({ state: "pending", firstAttempt: new Date().toISOString(), body })]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT value FROM app_settings WHERE key=$1 FOR UPDATE SKIP LOCKED", [key]);
      const state = locked.rows[0]?.value;
      if (!state || state.state !== "pending" || Date.parse(state.nextAt ?? "") > Date.now()) {
        await client.query("ROLLBACK"); continue;
      }
      if (!emailRetryWindowOpen(state.firstAttempt)) {
        state.state = "review_required";
        log.error({ incident: incident.key }, "AutoPrint email delivery unconfirmed; retry window closed. Verify Resend delivery manually.");
      } else {
        try {
          const response = await withEmailTimeout(new ReplitConnectors().proxy("resend", "/emails", {
            method: "POST", headers: { "Content-Type": "application/json",
              "Idempotency-Key": createHash("sha256").update(key).digest("hex") },
            body: JSON.stringify(state.body),
          }));
          if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
          const result = await response.json() as { id?: string };
          if (!result.id) throw new Error("Resend did not confirm a message ID");
          state.state = "sent"; state.providerId = result.id; state.sentAt = new Date().toISOString();
          log.info({ incident: incident.key, providerId: result.id }, "AutoPrint failure email accepted");
        } catch (err) {
          state.nextAt = new Date(Date.now() + 5 * 60_000).toISOString();
          log.error({ err, incident: incident.key }, "AutoPrint failure email not confirmed; will retry with the same idempotency key");
        }
      }
      await client.query("UPDATE app_settings SET value=$2::jsonb,updated_at=now() WHERE key=$1", [key, JSON.stringify(state)]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      log.error({ err, incident: incident.key }, "AutoPrint email delivery ledger failed");
    } finally { client.release(); }
  }
}

async function withEmailTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Resend acknowledgement timed out")), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}
