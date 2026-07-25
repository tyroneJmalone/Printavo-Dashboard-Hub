import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Chipply web stores imported into the hub (Chipply has no open API — data
 * arrives via pasted "Web Store Closed" emails and, later, portal export
 * files). Chipply dollars live ONLY here and must never be mixed into
 * Printavo invoice revenue (the related Printavo "merch" invoices are $0
 * production-management shells).
 *
 * NOT related to pv_merch_stores/pv_merch_orders — those mirror Printavo's
 * own merch platform and have nothing to do with Chipply.
 *
 * Linked Printavo invoices are derived LIVE from the nickname convention
 * "<event_id> <Store Name> <METHOD>: ..." — no link table, so links
 * self-heal as sync brings in new decoration-method invoices.
 * event_id is nullable because the store-closed email does not contain it;
 * staff confirm it from suggested invoice matches at import time.
 */
export const chipplyStoresTable = pgTable(
  "chipply_stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id"),
    storeName: text("store_name").notNull(),
    orgContact: text("org_contact"),
    storeAdmin: text("store_admin"),
    closedAt: date("closed_at"),
    numOrders: integer("num_orders"),
    numProducts: integer("num_products"),
    totalDollars: numeric("total_dollars", { precision: 12, scale: 2 }),
    fundraising: numeric("fundraising", { precision: 12, scale: 2 }),
    pvCustomerId: text("pv_customer_id"),
    notes: text("notes"),
    rawSource: text("raw_source"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("chipply_stores_event_id_uq")
      .on(t.eventId)
      .where(sql`${t.eventId} IS NOT NULL`),
  ],
);

export type ChipplyStore = typeof chipplyStoresTable.$inferSelect;
export type InsertChipplyStore = typeof chipplyStoresTable.$inferInsert;
