import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
const outfile = "/tmp/active-autoprint-alerts.mjs";
try {
  await build({
    stdin: { resolveDir: import.meta.dirname, loader: "ts", contents: `
      import assert from "node:assert/strict";
      import { PgDialect } from "drizzle-orm/pg-core";
      import { activeAlertPredicate } from "./src/lib/printQueue/autoPrint/activeAlerts";
      import { pool } from "@workspace/db";
      // A single read-only SELECT with CTE fixtures. No public tables, sequences or writes.
      const predicate = new PgDialect().sqlToQuery(activeAlertPredicate);
      const query = (recovered=false, baseline=false) => \`
        WITH pq_print_jobs AS (
          SELECT id, status, error_message, 'workorder'::text AS doc_type, 'job-run'::text AS run_id,
            CASE WHEN id='expired' THEN now()-interval '1 hour' ELSE now()+interval '1 hour' END AS lease_until,
            now()-interval '1 hour' AS created_at
          FROM (VALUES ('recovered','printed',null),('retry','retry_pending','403'),
            ('exhausted','exhausted','403'),('held','held','Review'),('unknown','submission_unknown','Unknown'),
            ('skip','skipped','Expected'),('cancel','cancelled','Cancelled'),('active','pending',null),
            ('expired','pending',null),('status-failed','printed','Status update failed')) j(id,status,error_message)
        ), pq_print_runs AS (
          SELECT 'job-run'::text AS id, 'success'::text AS status, false AS dry_run,
            '{}'::jsonb AS summary, now()-interval '2 hours' AS started_at,
            now()-interval '1 hour' AS finished_at, now()-interval '1 hour' AS updated_at
          UNION ALL
          SELECT id, status, false, jsonb_build_object('error',error), now()-age,
            now()-age, now()-age FROM (VALUES
            ('old-warning','success','Makeups additions not checked: Invalid',interval '40 minutes'),
            ('new-warning','success','Makeups additions not checked: Invalid',interval '30 minutes'),
            ('discovery','failed','Discovery failed',interval '20 minutes')
          ) r(id,status,error,age)
          \${recovered ? "UNION ALL SELECT 'recovery','success',false,'{}'::jsonb,now()-interval '5 minutes',now(),now()" : ""}
        ), pq_admin_alerts AS (
          SELECT id, id AS job_id, 'job-run'::text AS run_id, '{}'::jsonb AS payload, now()-interval '1 minute' AS created_at
            FROM pq_print_jobs
          UNION ALL SELECT 'older-exhausted','exhausted','job-run','{}'::jsonb,now()-interval '10 minutes'
          UNION ALL SELECT id,null,id,jsonb_build_object('reason',summary->>'error'),started_at
            FROM pq_print_runs WHERE id IN ('old-warning','new-warning','discovery')
        ), app_settings AS (
          SELECT 'autoprint.makeups-additions-baseline'::text AS key,
            jsonb_build_object('observedAt', to_char((now()-interval '\${baseline ? "1 minute" : "3 hours"}') AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS value
        )
        SELECT pq_admin_alerts.id FROM pq_admin_alerts
          LEFT JOIN pq_print_jobs ON pq_print_jobs.id=pq_admin_alerts.job_id
          LEFT JOIN pq_print_runs ON pq_print_runs.id=pq_admin_alerts.run_id
        WHERE \${predicate.sql} ORDER BY pq_admin_alerts.id
      \`;
      try {
        const ids = async (r=false,b=false) => (await pool.query(query(r,b),predicate.params)).rows.map(r=>r.id);
        assert.deepEqual(await ids(),['discovery','exhausted','expired','held','new-warning','status-failed','unknown']);
        assert.deepEqual(await ids(true),['exhausted','expired','held','new-warning','status-failed','unknown']);
        assert.deepEqual(await ids(true,true),['exhausted','expired','held','status-failed','unknown']);
        console.log('PASS active inbox SQL: recovered, scheduled, skipped, cancelled, deduplication, expired leases, unknown acceptance, status failures, run recovery, Makeups baseline recovery');
      } finally { await pool.end(); }
    `},
    outfile, bundle: true, platform: "node", format: "esm",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  process.exitCode = spawnSync(process.execPath, [outfile], { stdio: "inherit" }).status ?? 1;
} finally { rmSync(outfile, { force: true }); }
