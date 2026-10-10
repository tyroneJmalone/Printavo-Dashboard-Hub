import { db, appSettingsTable, pqPrintJobsTable as jobs, pqPrintAttemptsTable as attempts,
  pqPrintRunsTable as runs, pqAdminAlertsTable as alerts } from "@workspace/db";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { deliverAlertEvents, jobAlertEvents, runAlertEvents } from "./alertEvents";

/** Production-only read observer. It NEVER calls a printer or changes source jobs.
 * No cursor advances on delivery failure: source evidence remains eligible next tick.
 * Unique event keys are the cross-worker/restart delivery guarantee.
 */
export async function collectAutoPrintAlerts(log: Logger) {
  const key = "autoprint_admin_alerts_started_production";
  await db.insert(appSettingsTable).values({ key, value: { since: new Date().toISOString() } }).onConflictDoNothing();
  const [setting] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  const since = new Date((setting.value as { since: string }).since);
  if (!Number.isFinite(since.getTime())) throw new Error("Invalid AutoPrint alert activation date");
  const changedAttempts = await db.select().from(attempts).where(or(gte(attempts.finishedAt, since), gte(attempts.startedAt, since)));
  const runRows = await db.select().from(runs).where(and(eq(runs.dryRun, false), gte(runs.updatedAt, since)));
  const jobIds = [...new Set(changedAttempts.map(a => a.jobId))];
  const runIds = runRows.map(r => r.id);
  const jobRows = await db.select().from(jobs).where(or(
    gte(jobs.createdAt, since),
    jobIds.length ? inArray(jobs.id, jobIds) : sql`false`,
    runIds.length ? inArray(jobs.runId, runIds) : sql`false`,
  ));
  const missingRunIds = [...new Set(jobRows.map(j => j.runId))].filter(id => !runIds.includes(id));
  const oldRuns = missingRunIds.length ? await db.select().from(runs).where(inArray(runs.id, missingRunIds)) : [];
  const byRun = new Map([...runRows, ...oldRuns].map(r => [r.id, r]));
  const events = runRows.flatMap(run => runAlertEvents(run, since));
  const byJob = new Map<string, typeof changedAttempts>();
  for (const attempt of changedAttempts) {
    const list = byJob.get(attempt.jobId) ?? []; list.push(attempt); byJob.set(attempt.jobId, list);
  }
  for (const job of jobRows) events.push(...jobAlertEvents(job, byJob.get(job.id) ?? [], byRun.get(job.runId), since));
  // Avoid issuing one duplicate INSERT for every historical failure on each tick.
  // This is only an optimization; the database unique key still arbitrates races.
  const delivered = new Set((await db.select({ key: alerts.eventKey }).from(alerts)).map(row => row.key));
  await deliverAlertEvents(events.filter(event => !delivered.has(event.eventKey)),
    async event => { await db.insert(alerts).values(event).onConflictDoNothing({ target: alerts.eventKey }); },
    error => log.error({ err: error }, "AutoPrint admin notification delivery failed; audit will be checked again"),
  );
}

let started = false;
export function startAutoPrintAlerts(log: Logger) {
  if (started || process.env.NODE_ENV !== "production") return;
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await collectAutoPrintAlerts(log); }
    catch (err) { log.error({ err }, "AutoPrint admin notification scan failed; printing is unaffected"); }
    finally { busy = false; }
  };
  void tick();
  setInterval(() => void tick(), 30_000).unref();
}
