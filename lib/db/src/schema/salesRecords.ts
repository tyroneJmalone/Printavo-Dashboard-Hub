import { pgTable, uuid, text, jsonb, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

/** Validated discriminated sales documents; independent of upstream Printavo records. */
export const salesRecordsTable = pgTable("sales_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  customerId: text("customer_id"),
  naturalKey: text("natural_key"),
  payload: jsonb("payload").notNull(),
  version: integer("version").notNull().default(1),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("sales_records_kind_idx").on(t.kind),
  index("sales_records_customer_idx").on(t.customerId),
  uniqueIndex("sales_records_active_key_uq").on(t.naturalKey).where(sql`${t.archived} = false`),
]);
export const insertSalesRecordSchema = createInsertSchema(salesRecordsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type SalesRecord = typeof salesRecordsTable.$inferSelect;
