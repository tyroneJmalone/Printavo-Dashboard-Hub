import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Curation collections (Product Finder phase 3).
 * Hub-owned tables — the optional customer link stores the Printavo customer
 * id as plain text (matching pv_customers.printavo_id) with NO foreign key,
 * because the sync process owns the pv_* table lifecycle (same convention as
 * customer_meta).
 *
 * Collection items reference catalog products by (vendor, style_name) — NOT
 * the catalog serial id — so they survive full catalog re-imports. Display
 * data (brand, title, image, cost) is joined live from catalog_products at
 * read time; nothing is snapshotted.
 */

export const collectionsTable = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Printavo customer id (pv_customers.printavo_id) — optional, no FK. */
    printavoCustomerId: text("printavo_customer_id"),
    notes: text("notes"),
    /** Clerk email of the staff member who created it. */
    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("collections_customer_ix").on(t.printavoCustomerId)],
);

export const collectionItemsTable = pgTable(
  "collection_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collectionsTable.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(), // 'sanmar' | 'ss'
    styleName: text("style_name").notNull(),
    /** Chosen color names for this style within the collection. */
    colors: text("colors").array().notNull().default([]),
    note: text("note"),
    /** Immutable server-recomputed palette match context; null for manual/legacy rows. */
    paletteMatchSnapshot: jsonb("palette_match_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("collection_items_coll_style_ux").on(t.collectionId, t.vendor, t.styleName),
  ],
);

export type Collection = typeof collectionsTable.$inferSelect;
export type CollectionItem = typeof collectionItemsTable.$inferSelect;
