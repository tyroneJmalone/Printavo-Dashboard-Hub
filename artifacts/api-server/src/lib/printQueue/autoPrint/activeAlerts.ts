import { sql } from "drizzle-orm";
import { pqAdminAlertsTable as alerts, pqPrintJobsTable as jobs, pqPrintRunsTable as runs } from "@workspace/db";

/** Inbox visibility only. Durable alerts and print audit records are never deleted. */
export const activeAlertPredicate = sql`(
  (
    ${alerts.eventKey} LIKE 'printnode:%' AND (
      (${alerts.payload}->>'retryState' IN ('printnode_error','printnode_expired')
        AND ${jobs.snapshotMetadata}->'printNodeMonitor'->>'state' IN ('error','expired'))
      OR (${alerts.eventKey} LIKE '%:monitor-unavailable'
        AND ${jobs.snapshotMetadata}->'printNodeMonitor'->>'state' = 'unavailable')
      OR (${alerts.eventKey} LIKE '%:stalled'
        AND ${jobs.snapshotMetadata}->'printNodeMonitor'->>'terminal' = 'false'
        AND ${jobs.snapshotMetadata}->'printNodeMonitor'->>'state' <> 'unavailable')
    )
  )
  OR
  (
    ${alerts.eventKey} NOT LIKE 'printnode:%' AND ${alerts.jobId} IS NOT NULL AND (
      ${jobs.status} IN ('failed', 'held', 'exhausted', 'submission_unknown')
      OR (${jobs.status} = 'printed' AND nullif(${jobs.errorMessage}, '') IS NOT NULL)
      OR (${jobs.status} = 'pending' AND (
        ${jobs.leaseUntil} < now()
        OR (${jobs.docType} <> 'workorder' AND
          (${runs.status} = 'failed' OR ${jobs.createdAt} < now() - interval '10 minutes'))
      ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM pq_admin_alerts newer
      WHERE newer.job_id = ${alerts.jobId}
        AND newer.event_key NOT LIKE 'printnode:%'
        AND (newer.created_at, newer.id) > (${alerts.createdAt}, ${alerts.id})
    )
  )
  OR (
    ${alerts.jobId} IS NULL AND ${alerts.runId} IS NOT NULL
    AND NOT ${runs.dryRun}
    AND (
      nullif(${runs.summary}->>'error', '') IS NOT NULL
      OR (${runs.status} IN ('failed', 'interrupted') AND NOT EXISTS (
        SELECT 1 FROM pq_print_jobs document WHERE document.run_id = ${runs.id}
      ))
      OR (${runs.status} = 'running' AND ${runs.updatedAt} < now() - interval '2 minutes')
    )
    AND NOT EXISTS (
      SELECT 1 FROM pq_print_runs recovered
      WHERE NOT recovered.dry_run AND recovered.started_at > ${runs.startedAt}
        AND coalesce(${runs.summary}->>'error', '') NOT LIKE 'Makeups additions not checked:%'
        AND recovered.status = 'success' AND recovered.finished_at IS NOT NULL
        AND nullif(recovered.summary->>'error', '') IS NULL
        AND coalesce(recovered.summary->>'interrupted', 'false') <> 'true'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pq_admin_alerts newer
      JOIN pq_print_runs newer_run ON newer_run.id = newer.run_id
      WHERE newer.job_id IS NULL AND newer.payload->>'reason' = ${alerts.payload}->>'reason'
        AND (newer_run.started_at, newer.created_at, newer.id)
          > (${runs.startedAt}, ${alerts.createdAt}, ${alerts.id})
    )
    AND NOT (
      coalesce(${runs.summary}->>'error', '') LIKE 'Makeups additions not checked:%'
      AND EXISTS (
        SELECT 1 FROM app_settings baseline
        WHERE baseline.key = 'autoprint.makeups-additions-baseline'
          AND baseline.value->>'observedAt' > to_char(${runs.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    )
  )
)`;
