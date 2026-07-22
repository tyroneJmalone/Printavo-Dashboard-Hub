import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Backup module (B4): account-level reference data captured as raw
 * blobs, one row per entity. Kinds: delivery_method, payment_term,
 * user, pricing_matrix, email_template, type_of_work, category,
 * preset_task_group. Refreshed by the daily reference sweep;
 * hash-guarded writes. Rows are never deleted (backup semantics) —
 * entities removed in Printavo simply stop being refreshed.
 * No FKs by design (delete+reinsert sync semantics elsewhere).
 */
export const pvReferenceBlobsTable = pgTable(
  "pv_reference_blobs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    printavoId: text("printavo_id").notNull(),
    data: jsonb("data").notNull(),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pv_reference_blobs_kind_id_uq").on(t.kind, t.printavoId),
  ],
);

export type PvReferenceBlob = typeof pvReferenceBlobsTable.$inferSelect;
export type InsertPvReferenceBlob = typeof pvReferenceBlobsTable.$inferInsert;
