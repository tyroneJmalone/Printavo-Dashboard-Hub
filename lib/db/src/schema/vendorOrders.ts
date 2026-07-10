import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { poFilesTable } from "./poFiles";

/**
 * Electronic vendor order submissions (SanMar submitPO SOAP / S&S REST
 * POST /orders). One row per submission attempt against a po_files record.
 *
 * The request payload is snapshotted BEFORE the network call so an ambiguous
 * failure (timeout) can be reconciled against the vendor instead of blindly
 * retried. The persisted payload is credential-free — auth is added only on
 * the wire, never stored.
 *
 * FK to po_files is safe: it's our table (unlike pv_* which sync
 * deletes+reinserts, so those never get FKs).
 */
export const vendorOrdersTable = pgTable(
  "vendor_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poFileId: uuid("po_file_id")
      .notNull()
      .references(() => poFilesTable.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(), // sanmar | ss
    /**
     * How the order was sent:
     * - dry_run: payload built + previewed, NO network call
     * - test: sent to the vendor's test env (SanMar test-ws) / testOrder flag
     * - live: real, money-committing order
     */
    mode: text("mode").notNull(),
    /**
     * pending → submitting → submitted | failed | unknown.
     * "unknown" = the network call was ambiguous (timeout / no clear ack);
     * NEVER auto-retried — must be reconciled via a vendor status lookup
     * before the PO can be submitted again.
     */
    status: text("status").notNull().default("pending"),
    poNumber: text("po_number").notNull(),
    shipMethod: text("ship_method"),
    /** { shipTo, attention, address1, address2, city, state, zip, email, residential }. */
    shippingAddress: jsonb("shipping_address"),
    /** Credential-free structured payload sent to the vendor — persisted before send. */
    requestPayload: jsonb("request_payload"),
    /** Vendor order/confirmation numbers. S&S may split across warehouses → array. */
    vendorOrderNumbers: jsonb("vendor_order_numbers"),
    /** Raw vendor response (parsed JSON for S&S, message/xml summary for SanMar). */
    rawResponse: jsonb("raw_response"),
    /** Latest vendor-reported status text from a tracking refresh. */
    vendorStatus: text("vendor_status"),
    /** Tracking payload: [{ orderNumber, carrier?, trackingNumber, ... }]. */
    tracking: jsonb("tracking"),
    error: text("error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    lastStatusCheckAt: timestamp("last_status_check_at", { withTimezone: true }),
    archived: boolean("archived").notNull().default(false),
    archiveNote: text("archive_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vendor_orders_po_file_id_idx").on(t.poFileId),
    index("vendor_orders_created_at_idx").on(t.createdAt),
    // The core idempotency guard against double-ordering. A LIVE order blocks
    // for its whole active life (submitting/submitted/unknown) so a PO can
    // never be re-ordered while one is outstanding. A TEST order only blocks
    // while it's actually in flight (submitting) — once it completes it must
    // NOT block the subsequent live submit (the intended test-then-live flow).
    // dry_run rows are always excluded so Tyler can preview repeatedly; failed
    // rows are excluded so a rejected submit can be corrected and retried.
    uniqueIndex("vendor_orders_active_uq")
      .on(t.poFileId)
      .where(
        sql`(mode = 'live' AND status IN ('submitting','submitted','unknown')) OR (mode = 'test' AND status = 'submitting')`,
      ),
  ],
);

export type VendorOrder = typeof vendorOrdersTable.$inferSelect;
export type InsertVendorOrder = typeof vendorOrdersTable.$inferInsert;
