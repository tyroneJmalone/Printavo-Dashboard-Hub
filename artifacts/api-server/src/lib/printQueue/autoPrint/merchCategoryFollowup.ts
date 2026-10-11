import { db, pqPrintJobsTable as jobs, type PqPrintJob } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { liveCategories, previewReview, commitReview } from "../../chipply/categoryReview";
import { retrySnapshot } from "./retryStore";

/** Claim once before any mutation. Interrupted/unknown follow-ups require manual
 * review, never an automatic resend of either category writes or the workorder. */
export async function assignAcceptedMerchCategories(job: PqPrintJob, log: Logger,
  deps = { liveCategories, previewReview, commitReview }) {
  const snapshot = retrySnapshot(job);
  const assignments = snapshot.categoryAssignments ?? [];
  if (!assignments.length) return;
  const claimed = await db.update(jobs).set({
    snapshotMetadata: sql`jsonb_set(${jobs.snapshotMetadata}, '{durableRetry,categoryFollowupClaimed}', 'true'::jsonb)`,
  }).where(and(eq(jobs.id, job.id), eq(jobs.status, "printed"),
    sql`coalesce(${jobs.snapshotMetadata}->'durableRetry'->>'categoryFollowupClaimed', 'false') = 'false'`)).returning({ id: jobs.id });
  if (!claimed.length) throw new Error("Category follow-up already claimed; verify completion manually before advancing status");
  const categories = await deps.liveCategories();
  const actor = `autoprint:${job.id}`;
  for (const name of new Set(assignments.map(a => a.categoryName))) {
    const matching = categories.filter(c => c.name.trim().toLowerCase() === name.toLowerCase());
    if (matching.length !== 1) throw new Error(`Official category is missing or ambiguous: ${name}`);
    const selected = assignments.filter(a => a.categoryName === name);
    for (let start = 0; start < selected.length; start += 100) {
      const preview = await deps.previewReview(actor, selected.slice(start, start + 100).map(a => ({
        orderId: job.printavoOrderId, lineItemId: a.lineItemId,
      })), false, matching[0].id);
      if (preview.lines.some(l => l.statusId !== job.sourceStatusId ||
        (l.currentCategoryId !== null && l.currentCategoryId !== matching[0].id))) {
        throw new Error("Status or category changed since printing; review required");
      }
      const result = await deps.commitReview(actor, preview.previewId, log);
      if (result.results.some(r => !["updated", "skipped"].includes(r.outcome))) {
        throw new Error("Some category assignments require manual review; accepted workorder will not be resent");
      }
    }
  }
}
