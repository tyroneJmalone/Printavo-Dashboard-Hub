import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { poStatusRulesTable } from "./poStatusRules";

/**
 * Suggested Printavo status changes produced by the status rules engine.
 * NOTHING is written to Printavo until Tyler applies a suggestion (preview/
 * confirm is mandatory — statusUpdate mutates real data).
 *
 * Rows snapshot everything needed to render the preview (order identity,
 * current status, matched rule, computed business days) so the list survives
 * reloads/restarts and stays meaningful even if pv_* rows are resynced.
 * NO foreign keys to pv_* tables (standing rule).
 *
 * state: 'pending' → 'applied' | 'dismissed' | 'failed' (failed keeps the
 * gateway error and can be retried via apply).
 */
export const poStatusSuggestionsTable = pgTable(
  "po_status_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderPrintavoId: text("order_printavo_id").notNull(),
    orderType: text("order_type").notNull(), // 'invoice' | 'quote'
    visualId: integer("visual_id"),
    nickname: text("nickname"),
    customerCompany: text("customer_company"),
    /** string[] of deco groups present, e.g. ["print","embroidery"]. */
    decoGroups: jsonb("deco_groups").notNull().default(sql`'[]'::jsonb`),
    mixed: boolean("mixed").notNull().default(false),
    currentStatusId: text("current_status_id"),
    currentStatusName: text("current_status_name"),
    suggestedStatusId: text("suggested_status_id").notNull(),
    suggestedStatusName: text("suggested_status_name").notNull(),
    ruleId: uuid("rule_id").references(() => poStatusRulesTable.id, {
      onDelete: "set null",
    }),
    /** Push-completion timestamp ("PO date") the rule window was computed from. */
    poDate: timestamp("po_date", { withTimezone: true }).notNull(),
    /** Customer due date snapshot (UTC-midnight date-only in Printavo). */
    dueDate: timestamp("due_date", { withTimezone: true }),
    businessDaysOut: integer("business_days_out"),
    state: text("state").notNull().default("pending"),
    error: text("error"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("po_status_suggestions_pending_order_uq")
      .on(t.orderPrintavoId)
      .where(sql`state = 'pending'`),
    index("po_status_suggestions_state_idx").on(t.state),
    index("po_status_suggestions_created_idx").on(t.createdAt),
  ],
);

export type PoStatusSuggestion = typeof poStatusSuggestionsTable.$inferSelect;
export type InsertPoStatusSuggestion = typeof poStatusSuggestionsTable.$inferInsert;
