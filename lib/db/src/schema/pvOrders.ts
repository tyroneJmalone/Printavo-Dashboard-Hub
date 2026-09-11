import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  date,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";

/**
 * Unified quotes + invoices snapshot (Printavo order union).
 * `data` holds the full raw API payload; hot columns are promoted for querying.
 * visual_id is indexed (not unique) — quote→invoice conversion may mint a new
 * printavo id for the same visual id; reconciliation happens in the sync engine.
 */
export const pvOrdersTable = pgTable(
  "pv_orders",
  {
    printavoId: text("printavo_id").primaryKey(),
    visualId: integer("visual_id").notNull(),
    orderType: text("order_type").notNull(), // 'quote' | 'invoice'
    statusId: text("status_id"),
    statusName: text("status_name"),
    nickname: text("nickname"),
    total: numeric("total", { precision: 12, scale: 2 }),
    amountOutstanding: numeric("amount_outstanding", {
      precision: 12,
      scale: 2,
    }),
    customerDueAt: timestamp("customer_due_at", { withTimezone: true }),
    // Date-only, user-editable in Printavo (defaults to creation date; re-datable).
    invoiceAt: date("invoice_at"),
    // Printavo `dueAt` — production due date (full datetime).
    productionDueAt: timestamp("production_due_at", { withTimezone: true }),
    // Date-only; defaults to invoiceAt in Printavo.
    paymentDueAt: date("payment_due_at"),
    contactId: text("contact_id"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    customerId: text("customer_id"),
    customerCompany: text("customer_company"),
    ownerEmail: text("owner_email"),
    printavoCreatedAt: timestamp("printavo_created_at", { withTimezone: true }),
    printavoUpdatedAt: timestamp("printavo_updated_at", { withTimezone: true }),
    data: jsonb("data").notNull(),
    contentHash: text("content_hash").notNull(),
    detailContentHash: text("detail_content_hash"),
    detailSyncedAt: timestamp("detail_synced_at", { withTimezone: true }),
    /** Fetch-start ordering fence for concurrent detail responses. */
    detailFetchStartedAt: timestamp("detail_fetch_started_at", {
      withTimezone: true,
    }),
    /** Complete, incomplete, or unknown when no detail has been observed. */
    detailSyncState: text("detail_sync_state").notNull().default("unknown"),
    detailSyncError: text("detail_sync_error"),
    // Backup module: full-fidelity supplemental payload (fees, expenses,
    // approvals, production files, mockups, ...) captured by a per-order
    // extras query. Raw blob — no hot columns; refreshed by the extras
    // drip whenever stale (order changed) or never captured.
    extras: jsonb("extras"),
    extrasContentHash: text("extras_content_hash"),
    extrasSyncedAt: timestamp("extras_synced_at", { withTimezone: true }),
    extrasStale: boolean("extras_stale").notNull().default(true),
    /** Last extras drip attempt (success OR failure) — lets the drip cycle
     * permanently-failing orders to the back instead of starving on them. */
    extrasAttemptedAt: timestamp("extras_attempted_at", { withTimezone: true }),
    /** Backup module (B3): true when the file registrar should (re)scan this
     * order's data+extras for mirrorable files. Default true = one-time
     * backfill over pre-existing rows; set true again on order change and
     * on extras write. */
    filesStale: boolean("files_stale").notNull().default(true),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("pv_orders_visual_id_idx").on(t.visualId),
    index("pv_orders_status_idx").on(t.statusId),
    index("pv_orders_customer_idx").on(t.customerId),
    index("pv_orders_pv_updated_idx").on(t.printavoUpdatedAt),
  ],
);

export type PvOrder = typeof pvOrdersTable.$inferSelect;
export type InsertPvOrder = typeof pvOrdersTable.$inferInsert;
