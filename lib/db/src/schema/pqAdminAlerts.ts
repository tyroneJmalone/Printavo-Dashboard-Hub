import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

/** Admin-only in-app delivery ledger. Never controls printing or status changes. */
export const pqAdminAlertsTable = pgTable("pq_admin_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventKey: text("event_key").notNull(),
  kind: text("kind").notNull(),
  jobId: uuid("job_id"),
  runId: uuid("run_id"),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("pq_admin_alerts_event_key_idx").on(t.eventKey)]);

export const pqAdminAlertReadsTable = pgTable("pq_admin_alert_reads", {
  alertId: uuid("alert_id").notNull().references(() => pqAdminAlertsTable.id, { onDelete: "cascade" }),
  adminEmail: text("admin_email").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.alertId, t.adminEmail] })]);
