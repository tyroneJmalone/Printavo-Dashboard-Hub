import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Local vendor product catalog (Product Finder phase 2).
 * Slow-moving product data only — live warehouse inventory is deliberately
 * NOT cached here (stock changes hourly; it is always fetched fresh from the
 * vendor at view time via the phase-1 lookup endpoints).
 *
 * Staff corrections live OUTSIDE the imported rows (catalog_color_families
 * rows with source='staff', catalog_tag_overrides) so nightly refreshes can
 * blow away and re-import vendor data without losing human input.
 */

export const catalogProductsTable = pgTable(
  "catalog_products",
  {
    id: serial("id").primaryKey(),
    vendor: text("vendor").notNull(), // 'sanmar' | 'ss'
    styleName: text("style_name").notNull(),
    /** Vendor-internal id (S&S styleID) — needed for S&S product fetches. */
    styleId: text("style_id"),
    brand: text("brand"),
    title: text("title"),
    /** Plain-text description (vendor HTML stripped at import). */
    description: text("description"),
    category: text("category"),
    styleImage: text("style_image"),
    /** Regular dealer cost range across sizes/colors (SanMar casePrice, S&S piecePrice). */
    priceMin: numeric("price_min"),
    priceMax: numeric("price_max"),
    /** Distinct size labels carried ("S","M","2/3X",...). */
    sizes: text("sizes").array().notNull().default([]),
    /** AI-assigned searchable attribute tags (garment type, gender, fabric, keywords). */
    tags: text("tags").array().notNull().default([]),
    /** Style disappeared from the vendor's sellable list on a later refresh. */
    discontinued: boolean("discontinued").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("catalog_products_vendor_style_ux").on(t.vendor, t.styleName),
    index("catalog_products_brand_ix").on(t.brand),
    index("catalog_products_category_ix").on(t.category),
  ],
);

export const catalogColorsTable = pgTable(
  "catalog_colors",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => catalogProductsTable.id, { onDelete: "cascade" }),
    colorName: text("color_name").notNull(),
    /** Lowercase alphanumeric-normalized name — join key into catalog_color_families. */
    normName: text("norm_name").notNull(),
    swatchImage: text("swatch_image"),
    productImage: text("product_image"),
  },
  (t) => [
    uniqueIndex("catalog_colors_product_color_ux").on(t.productId, t.colorName),
    index("catalog_colors_norm_ix").on(t.normName),
  ],
);

/**
 * Global color-name → color-family map, shared across vendors and products.
 * AI fills it once per unique color name at import time; staff corrections
 * (source='staff') are never overwritten by later AI passes.
 */
export const catalogColorFamiliesTable = pgTable(
  "catalog_color_families",
  {
    /** Normalized color name (lowercase alphanumeric) — primary key. */
    normName: text("norm_name").primaryKey(),
    /** Display form of the color name as first seen. */
    colorName: text("color_name").notNull(),
    families: text("families").array().notNull().default([]),
    source: text("source").notNull().default("ai"), // 'ai' | 'staff'
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Staff tag corrections per product, keyed by (vendor, style_name) — NOT the
 * serial id — so they survive a full re-import. Effective tags at search
 * time = (imported tags ∪ add_tags) − remove_tags.
 */
export const catalogTagOverridesTable = pgTable(
  "catalog_tag_overrides",
  {
    id: serial("id").primaryKey(),
    vendor: text("vendor").notNull(),
    styleName: text("style_name").notNull(),
    addTags: text("add_tags").array().notNull().default([]),
    removeTags: text("remove_tags").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("catalog_tag_overrides_vendor_style_ux").on(t.vendor, t.styleName)],
);

/** One nightly/manual refresh attempt per vendor — feeds the health panel. */
export const catalogRefreshRunsTable = pgTable(
  "catalog_refresh_runs",
  {
    id: serial("id").primaryKey(),
    vendor: text("vendor").notNull(), // 'sanmar' | 'ss' | 'tagging'
    status: text("status").notNull().default("running"), // running | completed | failed
    trigger: text("trigger").notNull().default("scheduler"), // scheduler | manual | seed
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    productsUpserted: integer("products_upserted").notNull().default(0),
    colorsUpserted: integer("colors_upserted").notNull().default(0),
    discontinuedCount: integer("discontinued_count").notNull().default(0),
    colorsTagged: integer("colors_tagged").notNull().default(0),
    productsTagged: integer("products_tagged").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("catalog_refresh_runs_vendor_ix").on(t.vendor, t.startedAt)],
);
