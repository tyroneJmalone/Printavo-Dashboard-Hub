import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Only explicit staff approvals; exact normalized source identity, never palette families. */
export const purchasingApprovedMappingsTable = pgTable("purchasing_approved_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendor: text("vendor").notNull(),
  sourceStyle: text("source_style").notNull(),
  sourceBrand: text("source_brand").notNull(),
  sourceColor: text("source_color").notNull(),
  vendorStyleId: text("vendor_style_id"),
  vendorStyle: text("vendor_style").notNull(),
  vendorColor: text("vendor_color").notNull(),
  approvedByEmail: text("approved_by_email").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("purchasing_approved_mappings_source_unique").on(t.vendor, t.sourceStyle, t.sourceBrand, t.sourceColor),
]);