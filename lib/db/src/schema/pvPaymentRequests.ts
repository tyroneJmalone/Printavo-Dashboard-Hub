import {
  pgTable,
  text,
  timestamp,
  jsonb,
  numeric,
} from "drizzle-orm/pg-core";

/**
 * Backup module (B4): Printavo payment requests, raw blob per request
 * (includes inline requestedDetails + payments connections). Newest-
 * first stop-early crawl each scheduled poll; full sweep daily.
 */
export const pvPaymentRequestsTable = pgTable("pv_payment_requests", {
  printavoId: text("printavo_id").primaryKey(),
  visualId: text("visual_id"),
  status: text("status"),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  data: jsonb("data").notNull(),
  contentHash: text("content_hash").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PvPaymentRequest = typeof pvPaymentRequestsTable.$inferSelect;
export type InsertPvPaymentRequest =
  typeof pvPaymentRequestsTable.$inferInsert;
