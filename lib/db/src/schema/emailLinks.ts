import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { emailMailboxesTable } from "./emailActivity";

/**
 * Email ↔ Printavo correlation links (Hub-owned tables).
 *
 * A thread is identified by (mailbox_id, gmail_thread_id) — same identity
 * the email_messages aggregates use. Links reference Printavo ids as plain
 * text (no FK to pv_* tables, matching customer_meta's convention).
 *
 * `source` is 'auto' (matching pass) or 'manual'. The auto pass only ever
 * INSERTs with ON CONFLICT DO NOTHING, so manual rows are never clobbered.
 * Removing an auto invoice link sets suppressed=true instead of deleting —
 * otherwise the next matching pass would just re-create it.
 */

export const emailThreadCustomersTable = pgTable(
  "email_thread_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    gmailThreadId: text("gmail_thread_id").notNull(),
    printavoCustomerId: text("printavo_customer_id").notNull(),
    /** 'auto' | 'manual' */
    source: text("source").notNull().default("auto"),
    /** The participant address that produced the auto match (lowercase). */
    matchedEmail: text("matched_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_thread_customers_ux").on(
      t.mailboxId,
      t.gmailThreadId,
      t.printavoCustomerId,
    ),
    index("email_thread_customers_customer_ix").on(t.printavoCustomerId),
  ],
);

export const emailThreadOrdersTable = pgTable(
  "email_thread_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    gmailThreadId: text("gmail_thread_id").notNull(),
    printavoOrderId: text("printavo_order_id").notNull(),
    /** Denormalized for display; pv_orders.visual_id at link time. */
    visualId: integer("visual_id"),
    /** 'auto' | 'manual' */
    source: text("source").notNull().default("auto"),
    /** Unlinked auto rows are suppressed, not deleted (blocks re-matching). */
    suppressed: boolean("suppressed").notNull().default(false),
    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_thread_orders_ux").on(
      t.mailboxId,
      t.gmailThreadId,
      t.printavoOrderId,
    ),
    index("email_thread_orders_order_ix").on(t.printavoOrderId),
  ],
);

export type EmailThreadCustomer = typeof emailThreadCustomersTable.$inferSelect;
export type EmailThreadOrder = typeof emailThreadOrdersTable.$inferSelect;
