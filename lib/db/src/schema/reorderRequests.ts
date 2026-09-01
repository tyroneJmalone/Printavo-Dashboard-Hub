import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Reorder Portal: customer-submitted reorder requests (public form).
 * Stored as a staff inbox — the sales team reviews each request and
 * follows up manually (later phases may add one-click invoice creation).
 * `items` holds the requested line items + per-size quantities as
 * submitted: [{ lineItemId, itemNumber, color, description, sizes: [{ label, qty }] }].
 */
export const reorderRequestsTable = pgTable(
  "reorder_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Printavo order id the customer reordered from (pv_orders.printavo_id, not FK — order rows can be resynced/deleted). */
    orderId: text("order_id").notNull(),
    visualId: integer("visual_id"),
    orderNickname: text("order_nickname"),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerCompany: text("customer_company"),
    notes: text("notes"),
    items: jsonb("items").notNull(),
    totalQty: integer("total_qty").notNull().default(0),
    /** 'new' | 'in_progress' | 'done' */
    status: text("status").notNull().default("new"),
    emailSent: boolean("email_sent").notNull().default(false),
  },
  (t) => [
    index("reorder_requests_status_idx").on(t.status),
    index("reorder_requests_created_idx").on(t.createdAt),
  ],
);

export type ReorderRequest = typeof reorderRequestsTable.$inferSelect;
export type InsertReorderRequest = typeof reorderRequestsTable.$inferInsert;
