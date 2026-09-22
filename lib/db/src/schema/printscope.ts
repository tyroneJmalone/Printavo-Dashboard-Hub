import { pgTable, uuid, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const printscopeRuleVersionsTable = pgTable("printscope_rule_versions", {
  id: serial("id").primaryKey(),
  rows: jsonb("rows").$type<Record<string, string>[]>().notNull(),
  csv: text("csv").notNull(),
  hash: text("hash").notNull(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
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
  result: jsonb("result").$type<Record<string, any>>(),
  assets: jsonb("assets").$type<Record<string, { path: string; kind: string; generation: string }>>(),
  error: jsonb("error").$type<{ code: string; message: string }>(),
  attempts: integer("attempts").default(0).notNull(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [index("printscope_queue_idx").on(t.environment, t.state, t.createdAt)]);
export const insertPrintscopeJobSchema = createInsertSchema(printscopeJobsTable);
export const insertPrintscopeRuleVersionSchema = createInsertSchema(printscopeRuleVersionsTable);
export type PrintscopeJob = typeof printscopeJobsTable.$inferSelect;