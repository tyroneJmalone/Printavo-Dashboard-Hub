import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const auditColumns = {
  createdByEmail: text("created_by_email").notNull(),
  updatedByEmail: text("updated_by_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** Hub-owned shared catalog. It is intentionally independent of all pv_* tables. */
export const brandingColorsTable = pgTable(
  "branding_colors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    hex: text("hex").notNull(),
    active: boolean("active").notNull().default(true),
    // Optional import-ready fields. The first spreadsheet import can preserve
    // its source references/availability notes without a second schema change.
    pantoneCode: text("pantone_code"),
    cmyk: jsonb("cmyk"),
    rgb: jsonb("rgb"),
    inkReferences: jsonb("ink_references"),
    threadReferences: jsonb("thread_references"),
    inkStockNotes: jsonb("ink_stock_notes"),
    threadStockNotes: jsonb("thread_stock_notes"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("branding_colors_name_uq").on(t.name)],
);

/** One Hub-owned branding record per Printavo customer (plain-text id, no pv_* FK). */
export const customerBrandingTable = pgTable("customer_branding", {
  printavoCustomerId: text("printavo_customer_id").primaryKey(),
  notes: text("notes"),
  fonts: text("fonts").array().notNull().default([]),
  ...auditColumns,
});

export const customerBrandingColorsTable = pgTable(
  "customer_branding_colors",
  {
    printavoCustomerId: text("printavo_customer_id")
      .notNull()
      .references(() => customerBrandingTable.printavoCustomerId, { onDelete: "cascade" }),
    role: text("role").notNull(),
    colorId: uuid("color_id")
      .notNull()
      .references(() => brandingColorsTable.id, { onDelete: "restrict" }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.printavoCustomerId, t.role] }),
    index("customer_branding_colors_color_idx").on(t.colorId),
  ],
);

/** Exactly one linked Dropbox root per Printavo customer. */
export const customerDropboxFoldersTable = pgTable("customer_dropbox_folders", {
  printavoCustomerId: text("printavo_customer_id").primaryKey(),
  dropboxId: text("dropbox_id").notNull(),
  pathLower: text("path_lower").notNull(),
  pathDisplay: text("path_display").notNull(),
  name: text("name").notNull(),
  ...auditColumns,
});

export const customerArtworkBookmarksTable = pgTable(
  "customer_artwork_bookmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    printavoCustomerId: text("printavo_customer_id")
      .notNull()
      .references(() => customerDropboxFoldersTable.printavoCustomerId, {
        onDelete: "cascade",
      }),
    dropboxId: text("dropbox_id").notNull(),
    pathLower: text("path_lower").notNull(),
    pathDisplay: text("path_display").notNull(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    notes: text("notes"),
    preferred: boolean("preferred").notNull().default(false),
    retired: boolean("retired").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("customer_artwork_bookmarks_customer_dropbox_uq").on(
      t.printavoCustomerId,
      t.dropboxId,
    ),
    index("customer_artwork_bookmarks_customer_idx").on(t.printavoCustomerId),
  ],
);

export type BrandingColor = typeof brandingColorsTable.$inferSelect;
export type CustomerBranding = typeof customerBrandingTable.$inferSelect;
export type CustomerDropboxFolder = typeof customerDropboxFoldersTable.$inferSelect;
export type CustomerArtworkBookmark = typeof customerArtworkBookmarksTable.$inferSelect;