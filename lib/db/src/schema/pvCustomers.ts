import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { searchVector } from "../searchVector";

export const pvCustomersTable = pgTable(
  "pv_customers",
  {
    printavoId: text("printavo_id").primaryKey(),
    companyName: text("company_name"),
    searchVector: searchVector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, coalesce(company_name, ''))`,
    ),
    primaryContactId: text("primary_contact_id"),
    ownerEmail: text("owner_email"),
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
    index("pv_customers_company_idx").on(t.companyName),
    index("pv_customers_company_search_idx").using(
      "gin",
      t.searchVector,
    ),
  ],
);

export type PvCustomer = typeof pvCustomersTable.$inferSelect;
export type InsertPvCustomer = typeof pvCustomersTable.$inferInsert;
