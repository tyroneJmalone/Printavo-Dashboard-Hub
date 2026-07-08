import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const pvContactsTable = pgTable(
  "pv_contacts",
  {
    printavoId: text("printavo_id").primaryKey(),
    fullName: text("full_name"),
    email: text("email"),
    phone: text("phone"),
    customerId: text("customer_id"),
    printavoCreatedAt: timestamp("printavo_created_at", { withTimezone: true }),
    printavoUpdatedAt: timestamp("printavo_updated_at", { withTimezone: true }),
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
    index("pv_contacts_email_idx").on(t.email),
    index("pv_contacts_customer_idx").on(t.customerId),
  ],
);

export type PvContact = typeof pvContactsTable.$inferSelect;
export type InsertPvContact = typeof pvContactsTable.$inferInsert;
