import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const pvStatusesTable = pgTable("pv_statuses", {
  printavoId: text("printavo_id").primaryKey(),
  name: text("name").notNull(),
  data: jsonb("data").notNull(),
  contentHash: text("content_hash").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PvStatus = typeof pvStatusesTable.$inferSelect;
export type InsertPvStatus = typeof pvStatusesTable.$inferInsert;
