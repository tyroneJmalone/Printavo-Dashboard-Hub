import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
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

/*
 * Migration note (Aug 2026 Brand Standards redesign): this schema was
 * restructured in place — fonts column dropped, JSONB production fields
 * converted to text, assignments re-keyed to uuid + lifecycle status,
 * typography/events tables added — WITHOUT a data migration, deliberately.
 * Verified before and after the push: every branding table held 0 rows in
 * development (only one artwork bookmark existed, preserved additively via
 * the new use_cases column default), and no production database exists yet
 * (the app has never been deployed with one — confirmed at redesign time).
 * There was no legacy data to backfill. Production schema, when first
 * deployed, is created by Replit's publish flow from this definition.
 */

/** Retire-instead-of-delete lifecycle shared by color/typography standards. */
const standardLifecycleColumns = {
  status: text("status").notNull().default("current"), // 'current' | 'retired'
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredByEmail: text("retired_by_email"),
};

/**
 * Hub-owned shared catalog. It is intentionally independent of all pv_* tables.
 * Production values are simple text so staff can record whatever the vendor
 * sheet says (RGB is always derived from hex in the UI — no stored duplicate).
 */
export const brandingColorsTable = pgTable(
  "branding_colors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    hex: text("hex").notNull(),
    active: boolean("active").notNull().default(true),
    pantoneCode: text("pantone_code"),
    cmyk: text("cmyk"),
    inkReferences: text("ink_references"),
    threadReferences: text("thread_references"),
    inkStockNotes: text("ink_stock_notes"),
    threadStockNotes: text("thread_stock_notes"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("branding_colors_name_uq").on(t.name)],
);

/** One Hub-owned branding record per Printavo customer (plain-text id, no pv_* FK). */
export const customerBrandingTable = pgTable("customer_branding", {
  printavoCustomerId: text("printavo_customer_id").primaryKey(),
  notes: text("notes"),
  ...auditColumns,
});

/**
 * Color assignments carry history: replacing/removing a role retires the old
 * row instead of deleting it, so "what changed and when" stays answerable.
 */
export const customerBrandingColorsTable = pgTable(
  "customer_branding_colors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    printavoCustomerId: text("printavo_customer_id")
      .notNull()
      .references(() => customerBrandingTable.printavoCustomerId, { onDelete: "cascade" }),
    role: text("role").notNull(),
    colorId: uuid("color_id")
      .notNull()
      .references(() => brandingColorsTable.id, { onDelete: "restrict" }),
    ...standardLifecycleColumns,
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("customer_branding_colors_current_role_uq")
      .on(t.printavoCustomerId, t.role)
      .where(sql`${t.status} = 'current'`),
    index("customer_branding_colors_customer_idx").on(t.printavoCustomerId),
    index("customer_branding_colors_color_idx").on(t.colorId),
  ],
);

/** Structured typography standards (role + font + capitalization + usage notes). */
export const customerBrandingTypographyTable = pgTable(
  "customer_branding_typography",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    printavoCustomerId: text("printavo_customer_id")
      .notNull()
      .references(() => customerBrandingTable.printavoCustomerId, { onDelete: "cascade" }),
    role: text("role").notNull(), // e.g. Headings, Body, Alternate
    fontName: text("font_name").notNull(),
    capitalization: text("capitalization"),
    usageNotes: text("usage_notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...standardLifecycleColumns,
    ...auditColumns,
  },
  (t) => [index("customer_branding_typography_customer_idx").on(t.printavoCustomerId)],
);

/**
 * Concise human-readable change history for a customer's brand standards.
 * No FK to customer_branding: logo (bookmark) events can exist before any
 * branding record does.
 */
export const customerBrandingEventsTable = pgTable(
  "customer_branding_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    printavoCustomerId: text("printavo_customer_id").notNull(),
    area: text("area").notNull(), // 'colors' | 'typography' | 'notes' | 'logos'
    summary: text("summary").notNull(),
    actorEmail: text("actor_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customer_branding_events_customer_idx").on(t.printavoCustomerId, t.createdAt),
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

/*
 * Logo bookmarks are brand-standard history: they are retired, never deleted.
 * Deliberately NO foreign key to customer_dropbox_folders — unlinking or
 * relinking the artwork folder retires bookmarks (route-level, with events)
 * instead of cascading a hard delete that would erase labels, approved-use
 * rules, and notes. Access to the underlying file is still revalidated
 * against the currently linked root at read time, so a stale bookmark can
 * never expose a file outside the customer's current folder.
 */
export const customerArtworkBookmarksTable = pgTable(
  "customer_artwork_bookmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    printavoCustomerId: text("printavo_customer_id").notNull(),
    dropboxId: text("dropbox_id").notNull(),
    pathLower: text("path_lower").notNull(),
    pathDisplay: text("path_display").notNull(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    notes: text("notes"),
    preferred: boolean("preferred").notNull().default(false),
    retired: boolean("retired").notNull().default(false),
    // Approved usage contexts: light_background | dark_background | print | embroidery | web | restricted
    useCases: text("use_cases").array().notNull().default([]),
    ...auditColumns,
  },
  (t) => [
    // Only ACTIVE bookmarks must be unique per file — retired history rows
    // for the same file may accumulate (e.g. retire, re-bookmark, retire).
    uniqueIndex("customer_artwork_bookmarks_customer_dropbox_uq")
      .on(t.printavoCustomerId, t.dropboxId)
      .where(sql`retired = false`),
    index("customer_artwork_bookmarks_customer_idx").on(t.printavoCustomerId),
  ],
);

export type BrandingColor = typeof brandingColorsTable.$inferSelect;
export type CustomerBranding = typeof customerBrandingTable.$inferSelect;
export type CustomerBrandingColorAssignment =
  typeof customerBrandingColorsTable.$inferSelect;
export type CustomerBrandingTypography =
  typeof customerBrandingTypographyTable.$inferSelect;
export type CustomerBrandingEvent = typeof customerBrandingEventsTable.$inferSelect;
export type CustomerDropboxFolder = typeof customerDropboxFoldersTable.$inferSelect;
export type CustomerArtworkBookmark = typeof customerArtworkBookmarksTable.$inferSelect;
