import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Auto-print engine runs (PQ3a). One row per engine pass (scheduled or
 * manual "run now"). Per-order outcomes live in pq_print_jobs; this row
 * carries the run-level lifecycle plus a summary snapshot.
 *
 * If the process restarts mid-run the row keeps status "running" but the id
 * is gone from the in-memory claim slot — readers MUST surface that as an
 * interrupted run (exact pq_status_jobs pattern).
 *
 * Snapshots only — NO foreign keys to pv_* tables.
 */
export const pqPrintRunsTable = pgTable(
  "pq_print_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What started the run: 'scheduled' | 'manual'. */
    trigger: text("trigger").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    /** running | success | failed (interrupted is computed by readers). */
    status: text("status").notNull(),
    /** Run-level detail: counts, config snapshot, error, advance-job id. */
    summary: jsonb("summary").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pq_print_runs_created_idx").on(t.createdAt)],
);

export type PqPrintRun = typeof pqPrintRunsTable.$inferSelect;
export type InsertPqPrintRun = typeof pqPrintRunsTable.$inferInsert;
