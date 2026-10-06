import { pgTable, uuid, integer, text, timestamp, index } from "drizzle-orm/pg-core";
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
}, t => [index("pq_print_attempts_job_idx").on(t.jobId)]);
