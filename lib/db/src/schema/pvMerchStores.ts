import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Backup module (B4): Printavo merch stores, raw blob per store
 * (includes summary totals). Refreshed by the daily merch sweep.
 */
export const pvMerchStoresTable = pgTable("pv_merch_stores", {
  printavoId: text("printavo_id").primaryKey(),
  name: text("name"),
  status: text("status"),
  data: jsonb("data").notNull(),
  contentHash: text("content_hash").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PvMerchStore = typeof pvMerchStoresTable.$inferSelect;
export type InsertPvMerchStore = typeof pvMerchStoresTable.$inferInsert;
