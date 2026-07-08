import {
  pgTable,
  bigserial,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const syncRunsTable = pgTable("sync_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runType: text("run_type").notNull(), // seed | incremental | backfill
  status: text("status").notNull().default("running"), // running | completed | failed
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  stats: jsonb("stats"),
  error: text("error"),
});

export type SyncRun = typeof syncRunsTable.$inferSelect;
export type InsertSyncRun = typeof syncRunsTable.$inferInsert;
