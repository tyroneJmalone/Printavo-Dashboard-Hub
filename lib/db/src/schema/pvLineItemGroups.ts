import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { pvOrdersTable } from "./pvOrders";

/**
 * Line item groups per order. Children of pv_orders — cascade on order
 * delete (quote→invoice conversion deletes the old order row).
 * Detail sync is order-granular: on change, all children of the order
 * are deleted and reinserted in one transaction.
 */
export const pvLineItemGroupsTable = pgTable(
  "pv_line_item_groups",
  {
    printavoId: text("printavo_id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => pvOrdersTable.printavoId, { onDelete: "cascade" }),
    position: integer("position"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("pv_lig_order_idx").on(t.orderId)],
);

export type PvLineItemGroup = typeof pvLineItemGroupsTable.$inferSelect;
export type InsertPvLineItemGroup = typeof pvLineItemGroupsTable.$inferInsert;
