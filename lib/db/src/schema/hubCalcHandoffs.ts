import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Hub Price Calculator — multi-style Printavo handoff claims.
 *
 * One row per operation (operationKey is unique and excludes the derived
 * append position, so re-previews after a write still dedupe/lock). The row is
 * inserted as `attempting` immediately before the single non-idempotent
 * Printavo call, so repeated clicks and concurrent requests can never issue
 * a second create. Ambiguous outcomes become `unknown` and stay locked.
 */
export type HubCalcHandoffStatus = "attempting" | "ok" | "unknown";

export const hubCalcHandoffsTable = pgTable(
  "hub_calc_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Full preview hash (includes derived append position); binds commit to preview. */
    snapshotHash: text("snapshot_hash").notNull(),
    /** Stable dedupe identity: snapshot minus derived group position. Unique. */
    operationKey: text("operation_key").notNull(),
    /** Canonical digest of the client request that claimed this operation. */
    requestDigest: text("request_digest").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    targetKind: text("target_kind").notNull(),
    mode: text("mode").notNull(),
    orderId: text("order_id"),
    visualId: integer("visual_id"),
    status: text("status").$type<HubCalcHandoffStatus>().notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    resultOrderId: text("result_order_id"),
    resultVisualId: integer("result_visual_id"),
    resultPublicUrl: text("result_public_url"),
    resultGroupId: text("result_group_id"),
    resultLineItemIds: jsonb("result_line_item_ids").$type<string[]>(),
    error: text("error"),
    actorEmail: text("actor_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("hub_calc_handoffs_operation_key_uq").on(t.operationKey),
    index("hub_calc_handoffs_request_digest_idx").on(t.requestDigest),
  ],
);

export type HubCalcHandoff = typeof hubCalcHandoffsTable.$inferSelect;
