import { pgTable, uuid, serial, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const printscopeRuleVersionsTable = pgTable("printscope_rule_versions", {
  id: serial("id").primaryKey(),
  rows: jsonb("rows").$type<Record<string, string>[]>().notNull(),
  csv: text("csv").notNull(),
  hash: text("hash").notNull(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const printscopePilotsTable = pgTable("printscope_pilots", {
  id: uuid("id").primaryKey().defaultRandom(),
  environment: text("environment").notNull(),
  ruleVersionId: integer("rule_version_id").references(() => printscopeRuleVersionsTable.id).notNull(),
  createdBy: uuid("created_by").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  purgeAfter: timestamp("purge_after", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("printscope_pilots_environment_uq").on(t.environment)]);
export const printscopeJobsTable = pgTable("printscope_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  environment: text("environment").notNull(),
  state: text("state").notNull(),
  filename: text("filename").notNull(),
  byteSize: integer("byte_size").notNull(),
  contentType: text("content_type").notNull(),
  sourcePath: text("source_path").notNull(),
  generation: text("generation"),
  sha256: text("sha256"),
  ruleVersionId: integer("rule_version_id").references(() => printscopeRuleVersionsTable.id).notNull(),
  submittedBy: uuid("submitted_by").notNull(),
  parentJobId: uuid("parent_job_id"),
  pilotId: uuid("pilot_id").references(() => printscopePilotsTable.id),
  pilotSourceId: uuid("pilot_source_id"),
  pilotProvenance: jsonb("pilot_provenance").$type<Record<string, any>>(),
  assetsExpiredAt: timestamp("assets_expired_at", { withTimezone: true }),
  cleanupAttemptedAt: timestamp("cleanup_attempted_at", { withTimezone: true }),
  cleanupError: text("cleanup_error"),
  result: jsonb("result").$type<Record<string, any>>(),
  assets: jsonb("assets").$type<Record<string, { path: string; kind: string; generation: string }>>(),
  error: jsonb("error").$type<{ code: string; message: string }>(),
  attempts: integer("attempts").default(0).notNull(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("printscope_queue_idx").on(t.environment, t.state, t.createdAt),
  uniqueIndex("printscope_pilot_import_uq").on(t.environment, t.pilotId, t.pilotSourceId, t.sha256, t.ruleVersionId).where(sql`${t.pilotId} IS NOT NULL AND ${t.parentJobId} IS NULL`),
]);
export const printscopePilotReviewsTable = pgTable("printscope_pilot_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => printscopeJobsTable.id).notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason"),
  note: text("note"),
  reviewerId: uuid("reviewer_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("printscope_pilot_reviews_job_idx").on(t.jobId, t.createdAt)]);
export const insertPrintscopeJobSchema = createInsertSchema(printscopeJobsTable);
export const insertPrintscopeRuleVersionSchema = createInsertSchema(printscopeRuleVersionsTable);
export type PrintscopeJob = typeof printscopeJobsTable.$inferSelect;