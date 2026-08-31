import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { correspondenceThreadsTable } from "./correspondence";
import { emailMailboxesTable } from "./emailActivity";

/**
 * Offline drafting backtest (Task #61): dry-run the Pattern C drafting
 * pipeline over HISTORICAL inbound customer emails that a teammate already
 * answered, and put the AI drafts side by side with the real reply.
 *
 * Measures fact accuracy and voice fidelity before go-live. It deliberately
 * CANNOT measure Pattern B's live ordering race or real accepted/edited
 * behavior — those still need the live measurement week. Nothing here
 * writes to Missive; drafts exist only in these tables for human review.
 */

export const draftBacktestRunsTable = pgTable("draft_backtest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 'running' | 'complete' | 'error' */
  status: text("status").notNull().default("running"),
  requestedByEmail: text("requested_by_email"),
  samplePerMailbox: integer("sample_per_mailbox").notNull(),
  itemsTotal: integer("items_total").notNull().default(0),
  itemsDone: integer("items_done").notNull().default(0),
  itemsFailed: integer("items_failed").notNull().default(0),
  /** Mailboxes skipped at start (no ready voice profile / no candidates). */
  skippedMailboxes: text("skipped_mailboxes").array().notNull().default([]),
  model: text("model").notNull().default(""),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const draftBacktestItemsTable = pgTable(
  "draft_backtest_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => draftBacktestRunsTable.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    /** Kept as a breadcrumb; content is snapshotted below so the item
     * survives thread re-syncs. */
    threadId: uuid("thread_id").references(() => correspondenceThreadsTable.id, {
      onDelete: "set null",
    }),
    subject: text("subject").notNull().default(""),
    counterpartEmail: text("counterpart_email").notNull().default(""),
    counterpartName: text("counterpart_name").notNull().default(""),
    /** Printavo customer matched from the counterpart email, if any. */
    customerId: text("customer_id"),
    customerName: text("customer_name").notNull().default(""),
    inboundAt: timestamp("inbound_at", { withTimezone: true }).notNull(),
    inboundText: text("inbound_text").notNull().default(""),
    replyAt: timestamp("reply_at", { withTimezone: true }).notNull(),
    /** The reply the teammate ACTUALLY sent — the ground truth. */
    replyText: text("reply_text").notNull().default(""),
    /** Context facts given to the model (same shape as the Pattern B note). */
    factsMarkdown: text("facts_markdown").notNull().default(""),
    /** Voice-profile-matched draft (Pattern C dry run). */
    voiceDraftBody: text("voice_draft_body").notNull().default(""),
    /** Same facts, neutral professional voice — the comparison baseline. */
    genericDraftBody: text("generic_draft_body").notNull().default(""),
    /** 'pending' | 'generated' | 'error' */
    status: text("status").notNull().default("pending"),
    error: text("error"),
    // ── Human review ─────────────────────────────────────────────────
    /** 'correct' | 'wrong_fact' | 'wrong_customer' | 'missing_data' */
    factAccuracy: text("fact_accuracy"),
    /** Which draft reads more like the real reply:
     * 'voice' | 'generic' | 'both' | 'neither' */
    voiceVerdict: text("voice_verdict"),
    /** Would the mailbox owner have used the voice draft:
     * 'as_is' | 'with_edits' | 'no' */
    wouldUse: text("would_use"),
    reviewNote: text("review_note").notNull().default(""),
    reviewedByEmail: text("reviewed_by_email"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("draft_backtest_items_run_ix").on(t.runId),
    index("draft_backtest_items_mailbox_ix").on(t.mailboxId),
  ],
);

export type DraftBacktestRun = typeof draftBacktestRunsTable.$inferSelect;
export type DraftBacktestItem = typeof draftBacktestItemsTable.$inferSelect;
