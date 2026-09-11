import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { pvOrdersTable } from "./pvOrders";

/**
 * Complete line-item observations for an order.
 *
 * A row is written only after a detail response has been proven complete.
 * The first row is the baseline (and deliberately does not create history
 * events). Later rows retain the complete before/after source needed to
 * explain change_events, including an empty-order baseline.
 */
export const pvOrderLineItemSnapshotsTable = pgTable(
  "pv_order_line_item_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => pvOrdersTable.printavoId, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncRunId: bigint("sync_run_id", { mode: "number" }),
    contentHash: text("content_hash").notNull(),
    /** Canonical line-item states, including stable upstream line IDs. */
    lineItems: jsonb("line_items").notNull(),
  },
  (t) => [
    index("pv_order_li_snapshots_order_idx").on(t.orderId, t.observedAt),
    index("pv_order_li_snapshots_observed_idx").on(t.observedAt),
  ],
);

export type PvOrderLineItemSnapshot =
  typeof pvOrderLineItemSnapshotsTable.$inferSelect;
export type InsertPvOrderLineItemSnapshot =
  typeof pvOrderLineItemSnapshotsTable.$inferInsert;