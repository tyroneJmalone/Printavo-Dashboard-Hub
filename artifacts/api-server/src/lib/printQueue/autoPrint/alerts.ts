import { db, appSettingsTable, pqPrintJobsTable as jobs, pqPrintAttemptsTable as attempts,
  pqPrintRunsTable as runs, pqAdminAlertsTable as alerts, pqAdminAlertCursorsTable as cursors } from "@workspace/db";
import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { jobAlertEvents, runAlertEvents, type AlertEvent, type AlertAttempt } from "./alertEvents";
import { ALERT_BATCH_SIZE, ALERT_STREAMS, collectAlertPage, nextAlertCursor,
  type AlertCursor, type AlertStream } from "./alertCursor";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Evidence = { jobId: string } | { runId: string };

/** Cursor strings round-trip through PostgreSQL, never through millisecond Date. */
function boundary(column: typeof jobs.createdAt | typeof attempts.startedAt | typeof attempts.finishedAt | typeof runs.updatedAt,
  id: typeof jobs.id | typeof attempts.id | typeof runs.id, since: Date, cursor: AlertCursor) {
  return and(gte(column, since), cursor.through ? sql`${column} <= ${cursor.through}::timestamptz` : undefined, cursor.after
    ? sql`(${column}, ${id}) > (${cursor.after.at}::timestamptz, ${cursor.after.id}::uuid)` : undefined);
}

export async function readAlertPage(tx: Tx, stream: AlertStream, cursor: AlertCursor, since: Date, reconcile: boolean) {
  if (reconcile && !cursor.through) cursor = { ...cursor, through: new Date().toISOString() };
  if (stream === "runs" || stream === "activeRuns") {
    // One run per page, with at most BATCH jobs. Persist unfinished fanout.
    let position = cursor.run;
    if (!position) {
      const [row] = await tx.select({ id: runs.id, at: sql<string>`${runs.updatedAt}::text` }).from(runs)
        .where(and(eq(runs.dryRun, false), boundary(runs.updatedAt, runs.id, since, cursor),
          stream === "activeRuns" ? eq(runs.status, "running") : undefined))
        .orderBy(asc(runs.updatedAt), asc(runs.id)).limit(1);
      position = row;
    }
    if (!position) return { items: [] as Evidence[], next: nextAlertCursor([], cursor, reconcile) };
    const rows = await tx.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.runId, position.id), position.jobAfter ? gt(jobs.id, position.jobAfter) : undefined))
      .orderBy(asc(jobs.id)).limit(ALERT_BATCH_SIZE);
    const next: AlertCursor = rows.length === ALERT_BATCH_SIZE
      ? { ...cursor, run: { ...position, jobAfter: rows[rows.length - 1].id } }
      : { through: cursor.through, after: { at: position.at, id: position.id } };
    return { items: [{ runId: position.id }, ...rows.map(j => ({ jobId: j.id }))] as Evidence[], next };
  }
  if (stream === "jobs" || stream === "activeJobs") {
    const rows = await tx.select({ id: jobs.id, at: sql<string>`${jobs.createdAt}::text` }).from(jobs)
      .where(and(boundary(jobs.createdAt, jobs.id, stream === "activeJobs" ? new Date(0) : since, cursor),
        stream === "activeJobs" ? sql`${jobs.status} in ('pending', 'submission_unknown') and (
          ${jobs.createdAt} >= ${since} or exists (
            select 1 from ${attempts} where ${attempts.jobId} = ${jobs.id}
            and (${attempts.startedAt} >= ${since} or ${attempts.finishedAt} >= ${since})
          ) or exists (
            select 1 from ${runs} where ${runs.id} = ${jobs.runId} and ${runs.startedAt} >= ${since}
          )
        )` : undefined))
      .orderBy(asc(jobs.createdAt), asc(jobs.id)).limit(ALERT_BATCH_SIZE);
    return { items: rows.map(j => ({ jobId: j.id })), next: nextAlertCursor(rows, cursor, reconcile) };
  }
  const column = stream === "attemptStarted" ? attempts.startedAt : attempts.finishedAt;
  const rows = await tx.select({ id: attempts.id, jobId: attempts.jobId, at: sql<string>`${column}::text` }).from(attempts)
    .where(boundary(column, attempts.id, since, cursor)).orderBy(asc(column), asc(attempts.id)).limit(ALERT_BATCH_SIZE);
  return { items: rows.map(a => ({ jobId: a.jobId })), next: nextAlertCursor(rows, cursor, reconcile) };
}

export async function evidenceEvents(tx: Tx, evidence: Evidence[], since: Date): Promise<AlertEvent[]> {
  const jobIds = [...new Set(evidence.flatMap(e => "jobId" in e ? [e.jobId] : []))];
  const jobRows = jobIds.length ? await tx.select().from(jobs).where(inArray(jobs.id, jobIds)) : [];
  const runIds = [...new Set([...jobRows.map(j => j.runId), ...evidence.flatMap(e => "runId" in e ? [e.runId] : [])])];
  const runRows = runIds.length ? await tx.select().from(runs).where(inArray(runs.id, runIds)) : [];
  const byRun = new Map(runRows.map(r => [r.id, r]));
  const events = evidence.flatMap(e => "runId" in e && byRun.has(e.runId) ? runAlertEvents(byRun.get(e.runId)!, since) : []);
  // Bounded indexed seeks (six outcome categories per subject), in one roundtrip.
  // Unlike loading a job's full attempt history this stays bounded even if a job
  // has been retried/reconciled for years.
  const firstRows = jobIds.length ? (await tx.execute<{
    jobId: string; outcome: string; error: string | null; phase: string; startedAt: string | Date; finishedAt: string | Date;
  }>(sql`
    select subject.job_id as "jobId", a.outcome, a.error, a.phase,
      a.started_at as "startedAt", a.finished_at as "finishedAt"
    from unnest(ARRAY[${sql.join(jobIds.map(id => sql`${id}::uuid`), sql`, `)}]) subject(job_id)
    cross join (values ('retry_pending'), ('failed'), ('held'), ('exhausted'), ('submission_unknown'), ('printed')) category(outcome)
    cross join lateral (
      select outcome, error, phase, started_at, finished_at from ${attempts}
      where job_id = subject.job_id and outcome = category.outcome
        and finished_at >= ${since} and error is not null and error <> ''
        and phase not in ('operator', 'reconciliation')
      order by finished_at, id limit 1
    ) a
  `)).rows : [];
  const byJob = new Map<string, AlertAttempt[]>();
  for (const row of firstRows) {
    const list = byJob.get(row.jobId) ?? [];
    list.push({ ...row, startedAt: new Date(row.startedAt), finishedAt: new Date(row.finishedAt) });
    byJob.set(row.jobId, list);
  }
  for (const job of jobRows) {
    const firsts = byJob.get(job.id) ?? [];
    // Establish eligibility for a pre-activation job even while its new attempt is unfinished.
    let [latest] = !firsts.length && job.createdAt < since
      ? await tx.select().from(attempts).where(and(eq(attempts.jobId, job.id), gte(attempts.startedAt, since)))
        .orderBy(asc(attempts.startedAt), asc(attempts.id)).limit(1) : [];
    if (!firsts.length && job.createdAt < since && !latest) {
      [latest] = await tx.select().from(attempts).where(and(eq(attempts.jobId, job.id), gte(attempts.finishedAt, since)))
        .orderBy(asc(attempts.finishedAt), asc(attempts.id)).limit(1);
    }
    const first = [...firsts].sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime())[0];
    const [next] = first ? await tx.select().from(attempts).where(and(eq(attempts.jobId, job.id), gt(attempts.startedAt, first.finishedAt!)))
      .orderBy(asc(attempts.startedAt), asc(attempts.id)).limit(1) : [];
    events.push(...jobAlertEvents(job, [...firsts, ...(latest ? [latest] : []), ...(next ? [next] : [])], byRun.get(job.runId), since));
  }
  return events;
}

/** Production-only read observer: never writes jobs, attempts, runs, or printers.
 * Each lane is bounded and locks its own durable checkpoint. Delivery and progress
 * are atomic; unique event keys arbitrate races between overlapping lanes/workers.
 * Reconciliation continually revisits activation-to-present in bounded pages,
 * catching commits delayed longer than any fixed overlap window. Active lanes
 * independently revisit abandoned fences/heartbeats even during a large backlog.
 */
export async function collectAutoPrintAlerts(log: Logger, database: Pick<typeof db, "insert" | "select" | "transaction"> = db) {
  const key = "autoprint_admin_alerts_started_production";
  await database.insert(appSettingsTable).values({ key, value: { since: new Date().toISOString() } }).onConflictDoNothing();
  const [setting] = await database.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  const since = new Date((setting.value as { since: string }).since);
  if (!Number.isFinite(since.getTime())) throw new Error("Invalid AutoPrint alert activation date");
  for (const stream of ALERT_STREAMS) {
    for (const reconcile of stream.startsWith("active") ? [true] : [false, true]) {
      const lane = `${stream}:${reconcile ? "reconcile" : "forward"}`;
      await database.insert(cursors).values({ key: lane }).onConflictDoNothing();
      try {
        await database.transaction(async tx => {
          const [state] = await tx.select().from(cursors).where(eq(cursors.key, lane)).for("update", { skipLocked: true });
          if (!state) return; // Another collector owns this page; no stale cursor overwrite.
          await collectAlertPage({
            read: () => readAlertPage(tx, stream, state.cursor as AlertCursor, since, reconcile),
            deliver: async evidence => {
              const events = await evidenceEvents(tx, evidence, since);
              if (!events.length) return;
              const keys = [...new Set(events.map(e => e.eventKey))];
              const delivered = new Set((await tx.select({ key: alerts.eventKey }).from(alerts)
                .where(inArray(alerts.eventKey, keys))).map(row => row.key));
              // Stable ordering prevents overlapping lane deliveries deadlocking.
              const pending = [...new Map(events.filter(e => !delivered.has(e.eventKey)).map(e => [e.eventKey, e])).values()]
                .sort((a, b) => a.eventKey.localeCompare(b.eventKey));
              if (pending.length) await tx.insert(alerts).values(pending).onConflictDoNothing({ target: alerts.eventKey });
            },
            checkpoint: async cursor => {
              await tx.update(cursors).set({ cursor, updatedAt: new Date() }).where(eq(cursors.key, lane));
            },
          });
        });
      } catch (err) {
        log.error({ err, lane }, "AutoPrint notification page failed; delivery and checkpoint will be retried");
      }
    }
  }
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
