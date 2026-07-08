import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { pvOrdersTable } from "./pvOrders";
import { pvLineItemGroupsTable } from "./pvLineItemGroups";

/**
 * Line items (garments/products) per group. order_id is denormalized for
 * single-join report aggregations. sizes holds [{ size, count }] as
 * returned by the API (size is the LineItemSize enum value).
 */
export const pvLineItemsTable = pgTable(
  "pv_line_items",
  {
    printavoId: text("printavo_id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => pvLineItemGroupsTable.printavoId, {
        onDelete: "cascade",
      }),
    orderId: text("order_id")
      .notNull()
      .references(() => pvOrdersTable.printavoId, { onDelete: "cascade" }),
    itemNumber: text("item_number"),
    color: text("color"),
    description: text("description"),
    categoryId: text("category_id"),
    categoryName: text("category_name"),
    brand: text("brand"),
    productId: text("product_id"),
    items: integer("items").notNull().default(0),
    price: numeric("price", { precision: 12, scale: 2 }),
    merch: boolean("merch").notNull().default(false),
    productStatus: text("product_status"),
    sizes: jsonb("sizes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("pv_li_order_idx").on(t.orderId),
    index("pv_li_group_idx").on(t.groupId),
    index("pv_li_item_number_idx").on(t.itemNumber),
    index("pv_li_brand_idx").on(t.brand),
    index("pv_li_category_idx").on(t.categoryName),
  ],
);

export type PvLineItem = typeof pvLineItemsTable.$inferSelect;
export type InsertPvLineItem = typeof pvLineItemsTable.$inferInsert;
