import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { aiQuoteDraftsTable } from "./aiQuoteDrafts";

export const aiQuoteDraftEventsTable = pgTable(
  "ai_quote_draft_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => aiQuoteDraftsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorEmail: text("actor_email"),
    printavoQuoteId: text("printavo_quote_id").notNull(),
    printavoVisualId: integer("printavo_visual_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_quote_draft_events_draft_created_idx").on(
      t.draftId,
      t.createdAt,
    ),
  ],
);

export const insertAiQuoteDraftEventSchema = createInsertSchema(
  aiQuoteDraftEventsTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertAiQuoteDraftEvent = z.infer<
  typeof insertAiQuoteDraftEventSchema
>;
export type AiQuoteDraftEvent = typeof aiQuoteDraftEventsTable.$inferSelect;