import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Every explicit staff edit; no communication is inferred to have been sent. */
export const salesRecordActivityTable = pgTable("sales_record_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  recordId: uuid("record_id").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("sales_record_activity_record_idx").on(t.recordId)]);
export const insertSalesRecordActivitySchema = createInsertSchema(salesRecordActivityTable).omit({ id: true, createdAt: true });
export type SalesRecordActivity = typeof salesRecordActivityTable.$inferSelect;
