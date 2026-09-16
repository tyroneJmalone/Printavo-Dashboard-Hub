import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Explicit staff feedback on an individual knowledge playground test.
 *
 * The result and source columns intentionally store snapshots. They are
 * submitted by the staff client and are never treated as canonical
 * knowledge, training data, or an instruction to change the knowledge base.
 */
export const knowledgePlaygroundFeedbackTable = pgTable(
  "knowledge_playground_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    message: text("message").notNull(),
    verdict: text("verdict").notNull(),
    issues: text("issues").array().notNull().default([]),
    comment: text("comment"),
    correctedReply: text("corrected_reply"),
    includeDrafts: boolean("include_drafts").notNull().default(false),
    resultSnapshot: jsonb("result_snapshot").notNull(),
    sources: jsonb("sources").notNull(),
    submittedByStaffId: uuid("submitted_by_staff_id").notNull(),
    submittedByEmail: text("submitted_by_email").notNull(),
    reviewed: boolean("reviewed").notNull().default(false),
    reviewedByStaffId: uuid("reviewed_by_staff_id"),
    reviewedByEmail: text("reviewed_by_email"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_playground_feedback_created_idx").on(t.createdAt),
    index("knowledge_playground_feedback_reviewed_idx").on(t.reviewed),
    index("knowledge_playground_feedback_submitted_by_idx").on(t.submittedByStaffId),
  ],
);

export type KnowledgePlaygroundFeedback = typeof knowledgePlaygroundFeedbackTable.$inferSelect;
export type InsertKnowledgePlaygroundFeedback =
  typeof knowledgePlaygroundFeedbackTable.$inferInsert;