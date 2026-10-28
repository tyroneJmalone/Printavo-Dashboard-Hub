import { pool } from "@workspace/db";
import { defaults, settingsInput } from "./automationPolicy";
import { environment } from "./worker";
export async function getSettings() {
  const row=(await pool.query("SELECT * FROM sepscope_automation_settings WHERE environment=$1",[environment])).rows[0];
  return {...defaults,...row?.settings,version:row?.version ?? 0,updatedBy:row?.updated_by ?? null};
}
export async function saveSettings(body: unknown, actor: string) {
  const input=settingsInput.parse(body);
  if((input.enabled || input.automaticActions) && !input.allowedStatusIds.length) throw new Error("Select eligible source statuses before enabling automation.");
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",["sepscope-settings:"+environment]);
    const row=(await c.query("SELECT * FROM sepscope_automation_settings WHERE environment=$1 FOR UPDATE",[environment])).rows[0];
    if((row?.version ?? 0)!==input.version) throw new Error("Settings changed. Reload before saving.");
    const {version,...settings}=input;
    const value={...settings,times:[...new Set(settings.times)].sort(),weekdays:[...new Set(settings.weekdays)].sort(),
      automaticSince:input.automaticActions ? row?.settings?.automaticActions ? row.settings.automaticSince : new Date().toISOString() : null};
    await c.query(`INSERT INTO sepscope_automation_settings(environment,version,settings,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(environment) DO UPDATE SET version=EXCLUDED.version,settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [environment,version+1,JSON.stringify(value),actor]);
    await c.query("COMMIT"); return getSettings();
  } catch(e) {await c.query("ROLLBACK");throw e;} finally {c.release();}
}
export async function automationData() {
  const [settings,items,runs,actions,emails,statuses]=await Promise.all([
    getSettings(),
    pool.query(`SELECT i.id,i.order_id AS "orderId",i.metadata->>'visualId' AS "visualId",
      i.metadata->>'customerName' AS "customerName",i.metadata->>'filename' AS filename,
      i.job_id AS "jobId",coalesce(j.state,'unavailable') AS state,j.result->>'verdict' AS verdict,
      coalesce(i.error,j.error->>'message') AS error,i.created_at AS "createdAt"
      FROM sepscope_automation_intake i LEFT JOIN printscope_jobs j ON j.id=i.job_id
      WHERE i.environment=$1 ORDER BY i.created_at DESC LIMIT 300`,[environment]),
    pool.query(`SELECT id,state,detail,created_at AS "createdAt" FROM sepscope_automation_runs WHERE environment=$1 ORDER BY created_at DESC LIMIT 30`,[environment]),
    pool.query(`SELECT id,order_id AS "orderId",decision,state,detail,created_at AS "createdAt" FROM sepscope_automation_actions WHERE environment=$1 ORDER BY created_at DESC LIMIT 100`,[environment]),
    pool.query(`SELECT id,state,error,created_at AS "createdAt" FROM sepscope_automation_emails WHERE environment=$1 ORDER BY created_at DESC LIMIT 50`,[environment]),
    pool.query("SELECT printavo_id AS id,name FROM pv_statuses ORDER BY name"),
  ]);
  return {settings,items:items.rows,runs:runs.rows,actions:actions.rows,emails:emails.rows,statuses:statuses.rows,
    limitations:["Pass actions always require staff confirmation of all required output files. Imprint counts are advisory, not proof of completeness.",
      "Dropbox requires files.content.write permission. Existing customer/#invoice folders only; no overwrites or folder creation.",
      "Automatic actions apply only to new failed inspections after activation, never the existing backlog. Successful inspections remain staff-reviewed.",
      "Scheduled scans, notification sending and upstream actions run only in production. Development supports manual read-only intake and inspection.",
      "Recent intake view shows up to 300 file versions; preview always checks the complete live invoice."]};
}
