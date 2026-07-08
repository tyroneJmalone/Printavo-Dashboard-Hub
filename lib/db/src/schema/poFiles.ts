import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Purchase order documents built from the needs-ordering cart.
 * Snapshots — NO foreign keys to pv_* tables (sync deletes+reinserts them);
 * Printavo ids are stored as plain text inside line_items jsonb.
 */
export const poFilesTable = pgTable(
  "po_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poNumber: text("po_number").notNull(),
    vendorName: text("vendor_name").notNull(), // sanmar | ss | manual
    notes: text("notes"),
    totalQuantity: integer("total_quantity").notNull(),
    totalCost: numeric("total_cost", { precision: 12, scale: 2 }).notNull(),
    /** PoFileLineItem[] snapshot — see purchasing types in api-server. */
    lineItems: jsonb("line_items").notNull(),
    pushedToPrintavoAt: timestamp("pushed_to_printavo_at", { withTimezone: true }),
    submittedToVendorAt: timestamp("submitted_to_vendor_at", { withTimezone: true }),
    /**
     * Manual unlock after a Printavo push (allowed) — vendor submission can
     * never be unlocked. A future re-push must reset this to false.
     */
    manuallyUnlocked: boolean("manually_unlocked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("po_files_created_at_idx").on(t.createdAt),
    uniqueIndex("po_files_po_number_uq").on(t.poNumber),
  ],
);

export type PoFile = typeof poFilesTable.$inferSelect;
export type InsertPoFile = typeof poFilesTable.$inferInsert;
