import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Print Queue status rules (PQ2) — SEPARATE from po_status_rules (the
 * purchasing engine). These fire after a workorder batch is PRINTED from the
 * Print Queue, not after a PO push.
 *
 * Matching model (Tyler's spec, 2026-07-13):
 * - trigger = source status(es) + optional deco composition + optional
 *   due-date window (business days from NOW to customer due date).
 * - sourceStatusIds: JSON array of Printavo status ids; empty array = any
 *   source status.
 * - Deco semantics identical to po_status_rules (specialMixedDeco /
 *   decoGroup / catch-all), reusing the purchasing composition logic.
 * - target NULLABLE: NULL = explicit "no change" rule (stops evaluation,
 *   changes nothing). Otherwise a pv_statuses snapshot pair.
 * - mode: 'off' = manual preset only (never fires after print);
 *   'ask' = confirmation panel after print (DEFAULT for new rules);
 *   'auto' = applies right after print. The app_settings master kill
 *   switch (pq_automation_enabled) gates 'ask' and 'auto' entirely.
 * - enabled=false disables the rule everywhere (automation AND presets).
 * First enabled rule by ascending priority wins per order.
 *
 * Snapshots only — NO foreign keys to pv_* tables (sync deletes+reinserts).
 */
export const pqStatusRulesTable = pgTable(
  "pq_status_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priority: integer("priority").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Optional human label; UI falls back to a generated description. */
    name: text("name"),
    /** JSON array of source Printavo status ids; empty = any status. */
    sourceStatusIds: jsonb("source_status_ids").notNull().default([]),
    /** 'print' | 'heat' | 'embroidery'; NULL = any composition (catch-all). */
    decoGroup: text("deco_group"),
    /** Matches orders with 2+ deco groups (or a Mixed Decoration line). */
    specialMixedDeco: boolean("special_mixed_deco").notNull().default(false),
    /** 'more_than' | 'at_most'; NULL (with dueBusinessDays NULL) = no date condition. */
    dueComparator: text("due_comparator"),
    dueBusinessDays: integer("due_business_days"),
    /** Printavo status snapshot; BOTH NULL = explicit "no change" rule. */
    targetStatusId: text("target_status_id"),
    targetStatusName: text("target_status_name"),
    /** 'off' | 'ask' | 'auto' — automation behavior after printing. */
    mode: text("mode").notNull().default("ask"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pq_status_rules_priority_idx").on(t.priority)],
);

export type PqStatusRule = typeof pqStatusRulesTable.$inferSelect;
export type InsertPqStatusRule = typeof pqStatusRulesTable.$inferInsert;
