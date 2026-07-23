import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { customerCategoriesTable } from "./customerCategories";

/**
 * Hub-owned metadata per Printavo customer (Client 360).
 * Keyed by the Printavo customer id as PLAIN TEXT — NO foreign key to
 * pv_customers (standing rule: sync owns pv_* lifecycles). FKs between our
 * own tables (category) are fine.
 *
 * One row per customer; a single category per customer is enforced by the PK.
 * CC2 will extend this table (notes, logo refs, etc.) instead of adding
 * parallel per-customer tables.
 */
export const customerMetaTable = pgTable(
  "customer_meta",
  {
    printavoCustomerId: text("printavo_customer_id").primaryKey(),
    categoryId: uuid("category_id").references(() => customerCategoriesTable.id, {
      onDelete: "restrict",
    }),
    assignedByEmail: text("assigned_by_email"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_meta_category_idx").on(t.categoryId)],
);

export type CustomerMeta = typeof customerMetaTable.$inferSelect;
export type InsertCustomerMeta = typeof customerMetaTable.$inferInsert;
