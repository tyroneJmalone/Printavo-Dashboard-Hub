import { sql } from "drizzle-orm";
import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Hub-native knowledge base served to AI consumers through the context
 * layer's knowledge-search tool.
 *
 * Editorial rule (from the Task #44 review): SOURCE MATERIAL IS NEVER
 * CANONICAL. Staff extract facts from sources (docs, emails, websites) into
 * structured entries; only entries with review_status='approved' are ever
 * served to any AI consumer. `source_name`/`source_url` are reference
 * breadcrumbs for staff, never returned through a door. `effective_date`
 * is when the FACT takes effect in the real world — distinct from
 * created/updated/reviewed timestamps.
 */
export const knowledgeEntriesTable = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** The reviewed fact text — this exact text is what consumers see. */
    body: text("body").notNull(),
    /** Grouping label: 'policy' | 'pricing' | 'production' | 'faq' | ... */
    category: text("category").notNull().default("general"),
    tags: text("tags").array().notNull().default([]),
    /** Where the fact was extracted from — staff reference only. */
    sourceName: text("source_name").notNull().default(""),
    sourceUrl: text("source_url").notNull().default(""),
    /** Calendar date the fact takes effect (nullable = always in effect). */
    effectiveDate: date("effective_date", { mode: "string" }),
    /** Optional calendar date the fact stops applying. */
    expiresDate: date("expires_date", { mode: "string" }),
    /** 'draft' | 'approved' | 'archived' — only approved entries serve. */
    reviewStatus: text("review_status").notNull().default("draft"),
    approvedByEmail: text("approved_by_email"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdByEmail: text("created_by_email"),
    updatedByEmail: text("updated_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("knowledge_entries_status_idx").on(t.reviewStatus),
    index("knowledge_entries_category_idx").on(t.category),
    index("knowledge_entries_search_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${t.title}, '') || ' ' || coalesce(${t.body}, ''))`,
    ),
  ],
);

export type KnowledgeEntry = typeof knowledgeEntriesTable.$inferSelect;
export type InsertKnowledgeEntry = typeof knowledgeEntriesTable.$inferInsert;
