import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Backup module (B4): individual thread messages (EmailMessage |
 * TextMessage), raw blob each, including attachment filename/url
 * metadata. Rows are never deleted (backup semantics).
 * No FK to pv_threads by design.
 */
export const pvMessagesTable = pgTable(
  "pv_messages",
  {
    printavoId: text("printavo_id").primaryKey(),
    threadPrintavoId: text("thread_printavo_id").notNull(),
    typename: text("typename").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    data: jsonb("data").notNull(),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("pv_messages_thread_idx").on(t.threadPrintavoId)],
);

export type PvMessage = typeof pvMessagesTable.$inferSelect;
export type InsertPvMessage = typeof pvMessagesTable.$inferInsert;
