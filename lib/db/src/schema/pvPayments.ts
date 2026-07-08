import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  date,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * All transaction types from Printavo (TransactionUnion): Payment,
 * PaymentDispute, Refund, Return, Void — discriminated by typename.
 * Cash-basis reporting buckets by transaction_date (user-settable, may be
 * backdated) and typically nets refunds against payments.
 * NOT FK-linked to pv_orders: a payment may reference an order outside
 * the synced 12-month window.
 */
export const pvPaymentsTable = pgTable(
  "pv_payments",
  {
    printavoId: text("printavo_id").primaryKey(),
    typename: text("typename").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    category: text("category"),
    source: text("source"),
    processing: boolean("processing"),
    description: text("description"),
    transactionDate: date("transaction_date"),
    orderId: text("order_id"),
    orderVisualId: integer("order_visual_id"),
    data: jsonb("data").notNull(),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("pv_pay_date_idx").on(t.transactionDate),
    index("pv_pay_order_idx").on(t.orderId),
    index("pv_pay_typename_idx").on(t.typename),
  ],
);

export type PvPayment = typeof pvPaymentsTable.$inferSelect;
export type InsertPvPayment = typeof pvPaymentsTable.$inferInsert;
