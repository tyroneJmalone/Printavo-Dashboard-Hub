import { pgTable, uuid, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pqPrintJobsTable } from "./pqPrintJobs";

export const pqPrintAttemptsTable = pgTable("pq_print_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => pqPrintJobsTable.id),
  attempt: integer("attempt").notNull(),
  leaseToken: uuid("lease_token").notNull(),
  phase: text("phase").notNull(),
  outcome: text("outcome").notNull(),
  error: text("error"),
  actor: text("actor").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, t => [
  index("pq_print_attempts_job_idx").on(t.jobId),
  index("pq_print_attempts_started_cursor_idx").on(t.startedAt, t.id),
  index("pq_print_attempts_finished_cursor_idx").on(t.finishedAt, t.id),
  index("pq_print_attempts_job_started_idx").on(t.jobId, t.startedAt, t.id),
  index("pq_print_attempts_job_finished_idx").on(t.jobId, t.finishedAt, t.id),
  index("pq_print_attempts_alert_evidence_idx").on(t.jobId, t.outcome, t.finishedAt, t.id)
    .where(sql`${t.error} is not null and ${t.error} <> '' and ${t.phase} not in ('operator', 'reconciliation')`),
]);
