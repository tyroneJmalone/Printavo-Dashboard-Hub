import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { pvOrdersTable } from "./pvOrders";
import { pvLineItemGroupsTable } from "./pvLineItemGroups";

/**
 * Imprints (decorations) per line item group. Pricing-matrix revenue
 * attribution splits group revenue evenly across its imprints
 * ("MatrixName: ColumnName" detail keys).
 */
export const pvImprintsTable = pgTable(
  "pv_imprints",
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
    details: text("details"),
    matrixName: text("matrix_name"),
    columnName: text("column_name"),
    typeOfWork: text("type_of_work"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("pv_imp_order_idx").on(t.orderId),
    index("pv_imp_group_idx").on(t.groupId),
    index("pv_imp_matrix_idx").on(t.matrixName),
  ],
);

export type PvImprint = typeof pvImprintsTable.$inferSelect;
export type InsertPvImprint = typeof pvImprintsTable.$inferInsert;
