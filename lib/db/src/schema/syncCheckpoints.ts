import {
  pgTable,
  serial,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Per-entity resume state within a sync run (page cursor + progress). */
export const syncCheckpointsTable = pgTable(
  "sync_checkpoints",
  {
    id: serial("id").primaryKey(),
    syncRunId: bigint("sync_run_id", { mode: "number" }).notNull(),
    entity: text("entity").notNull(), // statuses | customers | contacts | quotes | invoices
    cursor: text("cursor"),
    lastVisualId: integer("last_visual_id"),
    completed: boolean("completed").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("sync_checkpoints_run_entity_idx").on(t.syncRunId, t.entity)],
);

export type SyncCheckpoint = typeof syncCheckpointsTable.$inferSelect;
export type InsertSyncCheckpoint = typeof syncCheckpointsTable.$inferInsert;
