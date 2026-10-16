import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Customer niche categories (Client 360). Managed by admins in the hub;
 * seeded idempotently at api-server boot. Never hard-deleted — deactivate
 * instead so historical report groupings stay resolvable.
 */
export const customerCategoriesTable = pgTable(
  "customer_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => customerCategoriesTable.id),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_categories_name_uq").on(t.name)],
);

export type CustomerCategory = typeof customerCategoriesTable.$inferSelect;
export type InsertCustomerCategory = typeof customerCategoriesTable.$inferInsert;
