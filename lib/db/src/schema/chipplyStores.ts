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
  index,
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
    // ── Financials from the Chipply SalesReport CSV export (CH2) ──────
    // All nullable — email-only imports never populate them. Money stays
    // numeric-as-string per project convention. "Total Dollars" from the
    // email = sell price; orderTotal below additionally includes
    // shipping/handling/tax — they are DIFFERENT numbers, keep both.
    salesperson: text("salesperson"),
    organizationName: text("organization_name"),
    openedAt: date("opened_at"),
    orgFee: numeric("org_fee", { precision: 12, scale: 2 }),
    productCost: numeric("product_cost", { precision: 12, scale: 2 }),
    productPrice: numeric("product_price", { precision: 12, scale: 2 }),
    processPrice: numeric("process_price", { precision: 12, scale: 2 }),
    combinedPrice: numeric("combined_price", { precision: 12, scale: 2 }),
    optionFees: numeric("option_fees", { precision: 12, scale: 2 }),
    sizeUpcharges: numeric("size_upcharges", { precision: 12, scale: 2 }),
    tax: numeric("tax", { precision: 12, scale: 2 }),
    shipping: numeric("shipping", { precision: 12, scale: 2 }),
    handlingFee: numeric("handling_fee", { precision: 12, scale: 2 }),
    // Can legitimately be negative (a credit).
    manualAdjustment: numeric("manual_adjustment", { precision: 12, scale: 2 }),
    orderTotal: numeric("order_total", { precision: 12, scale: 2 }),
    paymentCard: numeric("payment_card", { precision: 12, scale: 2 }),
    paymentKlarna: numeric("payment_klarna", { precision: 12, scale: 2 }),
    paymentEcert: numeric("payment_ecert", { precision: 12, scale: 2 }),
    paymentPo: numeric("payment_po", { precision: 12, scale: 2 }),
    paymentPromo: numeric("payment_promo", { precision: 12, scale: 2 }),
    chipplyFee: numeric("chipply_fee", { precision: 12, scale: 2 }),
    ccProcessingFee: numeric("cc_processing_fee", { precision: 12, scale: 2 }),
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

/**
 * Per-style margin rows from the Chipply "Margin Report" CSV export.
 * The file carries NO store identifier, so rows are only imported from a
 * store's detail page (store context supplied by the URL). Re-importing
 * REPLACES the store's rows (delete + insert in one transaction) — the
 * export is a full snapshot, not a delta.
 *
 * Chipply-side dollars — same hard rule as chipply_stores: never mixed
 * into Printavo revenue.
 */
export const chipplyStoreStylesTable = pgTable(
  "chipply_store_styles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => chipplyStoresTable.id, { onDelete: "cascade" }),
    vendorName: text("vendor_name"),
    style: text("style"),
    productName: text("product_name"),
    purchases: integer("purchases"),
    totalSale: numeric("total_sale", { precision: 12, scale: 2 }),
    totalCost: numeric("total_cost", { precision: 12, scale: 2 }),
    totalProfit: numeric("total_profit", { precision: 12, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chipply_store_styles_store_idx").on(t.storeId)],
);

export type ChipplyStoreStyle = typeof chipplyStoreStylesTable.$inferSelect;
export type InsertChipplyStoreStyle =
  typeof chipplyStoreStylesTable.$inferInsert;
