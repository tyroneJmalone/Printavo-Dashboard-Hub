import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Backup module (B3): registry of order files mirrored into object storage.
 * Rows are extracted from data already held in pv_orders (data + extras
 * jsonb) by the file registrar — no Printavo API calls involved. A mirror
 * worker drains status='pending' rows by downloading the source URL
 * (no-auth public/CDN links) and streaming the bytes to the private
 * object dir.
 *
 * Snapshot semantics: rows are never deleted when a file disappears from
 * the order (it's a backup — deletion is a non-goal). Re-registration of
 * the same (order, kind, source_id) with a changed URL resets the row to
 * pending; the order's public PDF is re-queued whenever the order content
 * changes (same URL, new bytes).
 */
export const pvFilesTable = pgTable(
  "pv_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderPrintavoId: text("order_printavo_id").notNull(),
    /** Denormalized for human lookup + stable storage paths. */
    orderVisualId: integer("order_visual_id").notNull(),
    /** 'public_pdf' | 'mockup' | 'production_file' */
    sourceKind: text("source_kind").notNull(),
    /** Printavo mockup/file id; sentinel 'pdf' for public_pdf. */
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    byteSize: bigint("byte_size", { mode: "number" }),
    /** GCS object name (full path within the bucket) once mirrored. */
    objectPath: text("object_path"),
    /** 'pending' | 'mirrored' | 'failed' (terminal; manual requeue only). */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Stamped BEFORE each download attempt (success OR failure) so the
     * worker cycles failing rows to the back instead of starving on them. */
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    mirroredAt: timestamp("mirrored_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pv_files_order_kind_source_uq").on(
      t.orderPrintavoId,
      t.sourceKind,
      t.sourceId,
    ),
    index("pv_files_status_attempted_idx").on(t.status, t.attemptedAt),
    index("pv_files_order_idx").on(t.orderPrintavoId),
  ],
);

export type PvFile = typeof pvFilesTable.$inferSelect;
export type InsertPvFile = typeof pvFilesTable.$inferInsert;
