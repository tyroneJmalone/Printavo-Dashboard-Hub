import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Typed change feed emitted by the sync engine. All future features that need
 * history (status-duration analytics, activity timeline, notification rules)
 * read from here.
 *
 * NOTE: occurred_at is OBSERVATION time (Printavo exposes no event
 * timestamps), so granularity equals the poll interval.
 */
export const changeEventsTable = pgTable(
  "change_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityType: text("entity_type").notNull(), // order | customer | contact | status
    entityId: text("entity_id").notNull(),
    visualId: integer("visual_id"),
    eventType: text("event_type").notNull(), // created | status_change | field_change | updated | converted
    field: text("field"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncRunId: bigint("sync_run_id", { mode: "number" }),
  },
  (t) => [
    index("change_events_entity_idx").on(t.entityType, t.entityId, t.occurredAt),
    index("change_events_occurred_idx").on(t.occurredAt),
    index("change_events_type_idx").on(t.eventType),
  ],
);

export type ChangeEvent = typeof changeEventsTable.$inferSelect;
export type InsertChangeEvent = typeof changeEventsTable.$inferInsert;
