import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

/**
 * Backup module (B4): Printavo inquiries (website contact-form leads),
 * raw blob per inquiry. Flat tiny entity; refreshed daily.
 */
export const pvInquiriesTable = pgTable("pv_inquiries", {
  printavoId: text("printavo_id").primaryKey(),
  unread: boolean("unread"),
  data: jsonb("data").notNull(),
  contentHash: text("content_hash").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PvInquiry = typeof pvInquiriesTable.$inferSelect;
export type InsertPvInquiry = typeof pvInquiriesTable.$inferInsert;
