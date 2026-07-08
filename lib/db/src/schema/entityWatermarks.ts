import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-entity incremental-sync watermark.
 * Set to RUN-START time (never completion time) and never advanced when a run
 * fails — closes race windows where records updated mid-run would be skipped.
 */
export const entityWatermarksTable = pgTable("entity_watermarks", {
  entity: text("entity").primaryKey(),
  watermark: timestamp("watermark", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type EntityWatermark = typeof entityWatermarksTable.$inferSelect;
export type InsertEntityWatermark = typeof entityWatermarksTable.$inferInsert;
