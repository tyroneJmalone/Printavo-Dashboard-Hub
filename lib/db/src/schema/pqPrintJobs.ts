import { pgTable, uuid, text, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Auto-print job history (PQ3a) — one row per order per doc type per run.
 * This is BOTH the audit log and the dedup source: an order counts as
 * "already printed" when a row exists with status 'printed' matching its
 * printavo_order_id OR visual_id (quote→invoice conversion mints a new
 * printavo id for the same visual id, so id-only dedup could double-print).
 * dry_run rows never count as printed.
 *
 * Snapshots only — NO foreign keys to pv_* tables.
 */
export const pqPrintJobsTable = pgTable(
  "pq_print_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    printavoOrderId: text("printavo_order_id").notNull(),
    visualId: text("visual_id"),
    nickname: text("nickname"),
    /** 'workorder' now; 'packing_slip' | 'box_label' arrive with PQ3b. */
    docType: text("doc_type").notNull().default("workorder"),
    sourceStatusId: text("source_status_id"),
    sourceStatusName: text("source_status_name"),
    targetStatusId: text("target_status_id"),
    targetStatusName: text("target_status_name"),
    printnodeJobId: text("printnode_job_id"),
    printerId: text("printer_id"),
    printerName: text("printer_name"),
    copies: integer("copies").notNull().default(1),
    /** pending | printed | failed | dry_run | skipped */
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    isReprint: boolean("is_reprint").notNull().default(false),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pq_print_jobs_run_idx").on(t.runId),
    index("pq_print_jobs_order_idx").on(t.printavoOrderId),
    index("pq_print_jobs_visual_idx").on(t.visualId),
    index("pq_print_jobs_created_idx").on(t.createdAt),
  ],
);

export type PqPrintJob = typeof pqPrintJobsTable.$inferSelect;
export type InsertPqPrintJob = typeof pqPrintJobsTable.$inferInsert;
