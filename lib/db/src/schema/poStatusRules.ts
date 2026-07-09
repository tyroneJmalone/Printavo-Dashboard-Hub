import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Status rules engine (P3d): after a PO push, orders whose need_ordering
 * items are all ordered get a suggested Printavo status change.
 *
 * Matching model (Tyler's spec, 2026-07-09):
 * - Only three decoration groups matter: print / heat / embroidery, derived
 *   from pv_line_items.category_name (mapping lives in api-server
 *   purchasing/statusRules.ts). All other categories (Shipping, Extras,
 *   Art, ...) are ignored.
 * - specialMixedDeco rule matches when MORE THAN ONE group is present on the
 *   order (or a "Mixed Decoration" line exists). Keep it top priority.
 * - decoGroup rule matches when that group is the ONLY one present.
 * - decoGroup NULL (and not mixed-deco) matches any order — catch-all.
 * - Optional due-date window: business days between the PO date (push
 *   completion) and the order's CUSTOMER due date (Tyler confirmed),
 *   Mon–Fri minus shop holidays.
 * First enabled rule by ascending priority wins.
 *
 * Snapshots only — NO foreign keys to pv_* tables (sync deletes+reinserts).
 */
export const poStatusRulesTable = pgTable(
  "po_status_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priority: integer("priority").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** 'print' | 'heat' | 'embroidery'; NULL = any composition (catch-all). */
    decoGroup: text("deco_group"),
    /** Matches orders with 2+ deco groups (or a Mixed Decoration line). */
    specialMixedDeco: boolean("special_mixed_deco").notNull().default(false),
    /** 'more_than' | 'at_most'; NULL (with dueBusinessDays NULL) = no date condition. */
    dueComparator: text("due_comparator"),
    dueBusinessDays: integer("due_business_days"),
    /** Printavo status id + name snapshot (pv_statuses at save time). */
    targetStatusId: text("target_status_id").notNull(),
    targetStatusName: text("target_status_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("po_status_rules_priority_idx").on(t.priority)],
);

export type PoStatusRule = typeof poStatusRulesTable.$inferSelect;
export type InsertPoStatusRule = typeof poStatusRulesTable.$inferInsert;
