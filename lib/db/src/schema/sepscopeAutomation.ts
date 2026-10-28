import { pgTable, text, uuid, jsonb, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
export const sepscopeSettings = pgTable("sepscope_automation_settings", {
  environment: text("environment").primaryKey(),
  version: integer("version").notNull().default(1),
  settings: jsonb("settings").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const sepscopeRuns = pgTable("sepscope_automation_runs", {
  id: uuid("id").primaryKey(),
  environment: text("environment").notNull(),
  slot: text("slot").notNull(),
  state: text("state").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [uniqueIndex("sepscope_run_slot_uq").on(t.environment, t.slot)]);
export const sepscopeIntake = pgTable("sepscope_automation_intake", {
  id: uuid("id").primaryKey(),
  environment: text("environment").notNull(),
  runId: uuid("run_id").notNull(),
  orderId: text("order_id").notNull(),
  fileId: text("file_id").notNull(),
  revision: text("revision").notNull(),
  jobId: uuid("job_id"),
  metadata: jsonb("metadata").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("sepscope_intake_revision_uq").on(t.environment,t.orderId,t.fileId,t.revision), index("sepscope_intake_invoice_idx").on(t.environment,t.orderId)]);
export const sepscopeActions = pgTable("sepscope_automation_actions", {
  id: uuid("id").primaryKey(),
  environment: text("environment").notNull(),
  orderId: text("order_id").notNull(),
  token: text("token").notNull(),
  decision: text("decision").notNull(),
  state: text("state").notNull(),
  reviewedBy: uuid("reviewed_by").notNull(),
  detail: jsonb("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [uniqueIndex("sepscope_action_token_uq").on(t.environment,t.token), index("sepscope_action_invoice_idx").on(t.environment,t.orderId)]);
export const sepscopeEmails = pgTable("sepscope_automation_emails", {
  id: uuid("id").primaryKey(),
  environment: text("environment").notNull(),
  batchKey: text("batch_key").notNull(),
  state: text("state").notNull(),
  body: jsonb("body").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("sepscope_email_batch_uq").on(t.environment,t.batchKey)]);
