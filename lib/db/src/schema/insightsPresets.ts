import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Saved "Ask AI" report presets. Each preset stores the exact SQL that
 * produced an answer the user approved — re-running a preset executes the
 * stored SQL verbatim through the same guarded read-only executor (no AI
 * call), so results are deterministic. Never hard-deleted — archive instead.
 */
export const insightsPresetsTable = pgTable("insights_presets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  question: text("question").notNull(),
  sql: text("sql").notNull(),
  createdByEmail: text("created_by_email"),
  archived: boolean("archived").notNull().default(false),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InsightsPreset = typeof insightsPresetsTable.$inferSelect;
export type InsertInsightsPreset = typeof insightsPresetsTable.$inferInsert;
