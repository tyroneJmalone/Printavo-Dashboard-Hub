import { db, pqPrintJobsTable as jobs, pqPrintRunsTable as runs, pqAdminAlertsTable as alerts } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getPrintJobStates } from "./printNode";
import { parsePrintNodeStates, printNodeProblem } from "./printNodeMonitorPolicy";

/** Observer only. Never changes job status, submits a print, or writes Printavo.
 * A transaction-scoped lock prevents multiple deployed workers duplicating checks.
 * Persist observations and deduplicated notifications together.
 */
export async function monitorPrintNode(log: Logger): Promise<void> {
  if (process.env.REPLIT_DEPLOYMENT !== "1") return;
  await db.transaction(async tx => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended('autoprint:printnode-monitor',0)) AS locked`);
    if (!lock.rows[0]?.locked) return;
    const candidates = await tx.select({ job: jobs }).from(jobs)
      .innerJoin(runs, eq(runs.id, jobs.runId))
      .where(and(eq(runs.dryRun, false),
        sql`${jobs.printnodeJobId} ~ '^[1-9][0-9]*$'`,
        sql`coalesce(${jobs.printedAt},${jobs.createdAt}) >= now() - interval '14 days'`,
        sql`coalesce(${jobs.snapshotMetadata}->'printNodeMonitor'->>'terminal','false') <> 'true'`,
        sql`coalesce(${jobs.snapshotMetadata}->'printNodeMonitor'->>'checkedAt','') < to_char(now() at time zone 'UTC' - interval '2 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`))
      .orderBy(sql`coalesce(${jobs.snapshotMetadata}->'printNodeMonitor'->>'checkedAt','')`, jobs.createdAt)
      .limit(20);
    if (!candidates.length) return;
    const now = new Date();
    const ids = [...new Set(candidates.map(({ job }) => job.printnodeJobId!))];
    let observations = new Map< string, import("./printNodeMonitorPolicy").NodeObservation>();
    let checkError: string | null = null;
    try { observations = parsePrintNodeStates(await getPrintJobStates(ids), ids, now); }
    catch { checkError = "PrintNode status API could not be read. This is a monitoring problem, not proof of a failed print."; log.warn("PrintNode monitoring check unavailable"); }
    for (const { job } of candidates) {
      const old = (job.snapshotMetadata as { printNodeMonitor?: { failures?: number } } | null)?.printNodeMonitor;
      const observation = observations.get(job.printnodeJobId!);
      const failures = observation ? 0 : (old?.failures ?? 0) + 1;
      const state = observation?.state ?? "unavailable";
      const message = observation?.message ?? (observation ? null : checkError ?? "PrintNode returned no state for this accepted job. Its outcome is unconfirmed.");
      const metadata = { ...observation, state, message, checkedAt: now.toISOString(), failures, terminal: observation?.terminal ?? false };
      await tx.update(jobs).set({
        snapshotMetadata: sql`jsonb_set(coalesce(${jobs.snapshotMetadata},'{}'::jsonb),'{printNodeMonitor}',${JSON.stringify(metadata)}::jsonb)`,
      }).where(eq(jobs.id, job.id));
      const stalled = observation && !observation.terminal && now.getTime() - (job.printedAt ?? job.createdAt).getTime() > 60 * 60_000;
      const problem = printNodeProblem(state);
      if (!problem && failures < 3 && !stalled) continue;
      const reason = problem
        ? `PrintNode reported ${state} for accepted job ${job.printnodeJobId}. ${message ?? ""}`
        : stalled ? `PrintNode job ${job.printnodeJobId} remains ${state} more than an hour after submission.`
        : `Status monitoring is unavailable for PrintNode job ${job.printnodeJobId} after repeated checks. ${message}`;
      await tx.insert(alerts).values({
        eventKey: `printnode:${job.id}:${problem ? "failure" : stalled ? "stalled" : "monitor-unavailable"}`,
        kind: "manual_review", jobId: job.id, runId: job.runId,
        payload: {
          title: `Invoice #${job.visualId ?? job.printavoOrderId} — ${problem ? "PrintNode error" : stalled ? "PrintNode job delayed" : "PrintNode monitoring unavailable"}`,
          reason: `${reason} Check PrintNode and the physical printer before any resend. Hub has not requeued this job.`,
          documentType: job.docType, visualId: job.visualId, poNumber: job.hubPoNumber,
          occurredAt: observation?.observedAt ?? now.toISOString(), retryState: `printnode_${state}`,
          nextAttemptAt: null, href: `/auto-print?run=${encodeURIComponent(job.runId)}#autoprint-run-history`,
        },
      }).onConflictDoNothing({ target: alerts.eventKey });
    }
  });
}
