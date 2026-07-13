import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Print Queue bulk status-change jobs (PQ2). One row per job; per-order
 * progress lives in `state` (persisted after every line, poPush pattern) so
 * a server restart can never silently lose track of which orders were
 * already written to Printavo.
 *
 * Shape of `state` (see api-server lib/printQueue/statusJobs.ts):
 * {
 *   status: "running" | "success" | "failed",
 *   startedAt, finishedAt?,
 *   lines: [{ orderId, visualId, nickname, fromStatusId, fromStatusName,
 *             targetStatusId, targetStatusName,
 *             status: "pending"|"done"|"failed"|"stale"|"skipped",
 *             error? }]
 * }
 *
 * If the process restarts mid-job the row keeps status "running" but the id
 * is gone from the in-memory claim slot — readers MUST surface that as an
 * interrupted job whose unfinished lines can be retried.
 *
 * Snapshots only — NO foreign keys to pv_* tables.
 */
export const pqStatusJobsTable = pgTable(
  "pq_status_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What started the job: 'manual' (bulk dialog) | 'ask' (confirmed panel) | 'auto'. */
    trigger: text("trigger").notNull(),
    state: jsonb("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pq_status_jobs_created_idx").on(t.createdAt)],
);

export type PqStatusJob = typeof pqStatusJobsTable.$inferSelect;
export type InsertPqStatusJob = typeof pqStatusJobsTable.$inferInsert;
