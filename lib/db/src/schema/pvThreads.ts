import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";

/**
 * Backup module (B4): Printavo message threads (thread summary blob).
 * Full messages live in pv_messages, captured by a per-thread drip:
 * `messages_stale` default true = free backfill over newly-registered
 * threads; the summary crawl re-flags a thread when its
 * lastReceivedMessage id changes; a weekly deep re-flag catches
 * outgoing-only activity (lastReceivedMessage tracks INCOMING only).
 * `messages_attempted_at` is stamped BEFORE each drip attempt so
 * permanently-failing threads cycle to the back (extras-drip pattern).
 */
export const pvThreadsTable = pgTable(
  "pv_threads",
  {
    printavoId: text("printavo_id").primaryKey(),
    orderPrintavoId: text("order_printavo_id"),
    orderVisualId: integer("order_visual_id"),
    unread: boolean("unread"),
    /** lastReceivedMessage.id from the thread summary — change signal. */
    lastMessageId: text("last_message_id"),
    messagesStale: boolean("messages_stale").notNull().default(true),
    messagesAttemptedAt: timestamp("messages_attempted_at", {
      withTimezone: true,
    }),
    messagesSyncedAt: timestamp("messages_synced_at", { withTimezone: true }),
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
    index("pv_threads_order_idx").on(t.orderPrintavoId),
    index("pv_threads_stale_idx").on(t.messagesStale, t.messagesAttemptedAt),
  ],
);

export type PvThread = typeof pvThreadsTable.$inferSelect;
export type InsertPvThread = typeof pvThreadsTable.$inferInsert;
