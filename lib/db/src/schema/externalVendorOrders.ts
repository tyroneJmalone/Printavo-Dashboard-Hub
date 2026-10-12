import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Tracking only: deliberately no FK to PO submissions and no submit state. */
export const externalVendorOrdersTable = pgTable("external_vendor_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendor: text("vendor").notNull(),
  reference: text("reference").notNull(),
  poNumber: text("po_number").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  archived: boolean("archived").notNull().default(false),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("external_vendor_orders_reference_uq").on(t.vendor, t.reference)]);
export const insertExternalVendorOrderSchema = createInsertSchema(externalVendorOrdersTable).omit({id:true,createdAt:true});
