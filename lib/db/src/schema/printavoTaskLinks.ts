import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Mapping between Printavo tasks and their moMINTum twins.
 *
 * Lives in the HUB's own database on purpose: the moMINTum Postgres is a live
 * shared prod DB owned by the standalone app and its schema must never be
 * altered from the hub. One row per synced pair; the last_synced_* columns are
 * the echo-prevention baseline for the 3-way completion compare
 * (momintum state vs printavo state vs last synced state).
 */
export const printavoTaskLinksTable = pgTable(
  "printavo_task_links",
  {
    id: serial("id").primaryKey(),
    /** Printavo Task.id (string ID from GraphQL). */
    printavoTaskId: text("printavo_task_id").notNull(),
    /** moMINTum tasks.id in the shared momintum DB. */
    momintumTaskId: integer("momintum_task_id").notNull(),
    /** Which system the task originated in: "printavo" | "momintum". */
    origin: text("origin").notNull(),
    /** Completion state as of the last successful sync (echo prevention). */
    lastSyncedCompleted: boolean("last_synced_completed").notNull().default(false),
    /** Content baseline for one-way content mirroring (printavo-origin). */
    lastSyncedName: text("last_synced_name"),
    lastSyncedDueAt: timestamp("last_synced_due_at", { withTimezone: true }),
    lastSyncedAssigneeEmail: text("last_synced_assignee_email"),
    /**
     * True when the moMINTum twin was (soft-)deleted by a user: we stop
     * mirroring entirely and never touch the Printavo task again.
     */
    suppressed: boolean("suppressed").notNull().default(false),
    /** Last sync cycle in which the Printavo task was seen in the open scan. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("printavo_task_links_pv_idx").on(t.printavoTaskId),
    uniqueIndex("printavo_task_links_mm_idx").on(t.momintumTaskId),
  ],
);

export type PrintavoTaskLink = typeof printavoTaskLinksTable.$inferSelect;
export type InsertPrintavoTaskLink = typeof printavoTaskLinksTable.$inferInsert;
