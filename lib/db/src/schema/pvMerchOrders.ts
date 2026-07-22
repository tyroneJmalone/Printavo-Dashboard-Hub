import {
  pgTable,
  text,
  timestamp,
  jsonb,
  numeric,
  index,
} from "drizzle-orm/pg-core";

/**
 * Backup module (B4): Printavo merch orders (per-store web shop
 * orders), raw blob each. Only reachable via merchStore(id).orders —
 * no root list — so the daily merch sweep pages every store's orders.
 * No FK to pv_merch_stores by design.
 */
export const pvMerchOrdersTable = pgTable(
  "pv_merch_orders",
  {
    printavoId: text("printavo_id").primaryKey(),
    visualId: text("visual_id"),
    storePrintavoId: text("store_printavo_id").notNull(),
    status: text("status"),
    total: numeric("total", { precision: 12, scale: 2 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    data: jsonb("data").notNull(),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("pv_merch_orders_store_idx").on(t.storePrintavoId)],
);

export type PvMerchOrder = typeof pvMerchOrdersTable.$inferSelect;
export type InsertPvMerchOrder = typeof pvMerchOrdersTable.$inferInsert;
