import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Email activity tracker (Hub-owned tables).
 *
 * Metadata only — headers + subjects, never bodies. Each tracked Google
 * Workspace mailbox syncs via the Gmail API (service account with
 * domain-wide delegation). Messages carry a `channel` column so a future
 * "interaction" of another kind (phone call, SMS) can live in the same
 * model without a schema rewrite.
 *
 * Exclusion model: automatic bulk signals (List-Unsubscribe, no-reply
 * sender, Gmail category labels) are stored as raw facts on the row
 * (hasListUnsubscribe, labelIds, counterpart address). `excludedReason`
 * is a pure function of those facts + the exclusion rules table, so a
 * rules change can retroactively reclassify everything with one SQL pass.
 * Excluded mail is never deleted — it lands in the "filtered" bucket.
 */

export const emailMailboxesTable = pgTable(
  "email_mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Primary address of the Workspace mailbox (lowercase). */
    email: text("email").notNull(),
    displayName: text("display_name"),
    active: boolean("active").notNull().default(true),
    /** Gmail historyId watermark for incremental sync. */
    lastHistoryId: text("last_history_id"),
    /** Resumable backfill cursor (messages.list pageToken). */
    backfillPageToken: text("backfill_page_token"),
    backfillStartedAt: timestamp("backfill_started_at", { withTimezone: true }),
    backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** 'never' | 'ok' | 'error' */
    lastSyncStatus: text("last_sync_status").notNull().default("never"),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("email_mailboxes_email_ux").on(t.email)],
);

export const emailMessagesTable = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Interaction channel — 'email' today, room for 'call' etc. later. */
    channel: text("channel").notNull().default("email"),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    gmailId: text("gmail_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    /** 'inbound' | 'outbound' relative to the mailbox owner. */
    direction: text("direction").notNull(),
    fromAddress: text("from_address").notNull().default(""),
    toAddresses: text("to_addresses").array().notNull().default([]),
    /**
     * The external party for exclusion matching: the sender for inbound,
     * the first recipient for outbound. Lowercase.
     */
    counterpartAddress: text("counterpart_address").notNull().default(""),
    counterpartDomain: text("counterpart_domain").notNull().default(""),
    subject: text("subject").notNull().default(""),
    internalDate: timestamp("internal_date", { withTimezone: true }).notNull(),
    sizeEstimate: integer("size_estimate").notNull().default(0),
    labelIds: text("label_ids").array().notNull().default([]),
    /** Raw automatic-bulk signals (facts, not verdicts). */
    hasListUnsubscribe: boolean("has_list_unsubscribe").notNull().default(false),
    isAutoSubmitted: boolean("is_auto_submitted").notNull().default(false),
    /**
     * Verdict of the classification pass. NULL = counted in stats.
     * 'rule-address' | 'rule-domain' | 'list-unsubscribe' | 'no-reply' |
     * 'gmail-category' | 'auto-submitted'
     */
    excludedReason: text("excluded_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_messages_mailbox_gmail_ux").on(t.mailboxId, t.gmailId),
    index("email_messages_mailbox_date_ix").on(t.mailboxId, t.internalDate),
    index("email_messages_thread_ix").on(t.mailboxId, t.gmailThreadId),
    index("email_messages_counterpart_ix").on(t.counterpartAddress),
    index("email_messages_counterpart_domain_ix").on(t.counterpartDomain),
  ],
);

export const emailExclusionRulesTable = pgTable(
  "email_exclusion_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'address' | 'domain' */
    kind: text("kind").notNull(),
    /** Lowercase address or bare domain (no @). */
    value: text("value").notNull(),
    note: text("note"),
    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("email_exclusion_rules_kind_value_ux").on(t.kind, t.value)],
);

/** Single-row settings (id always 1). */
export const emailActivitySettingsTable = pgTable("email_activity_settings", {
  id: integer("id").primaryKey().default(1),
  /** Threads with no reply past this many hours show as "unanswered". */
  unansweredThresholdHours: integer("unanswered_threshold_hours").notNull().default(24),
  /** First-run backfill horizon. */
  backfillDays: integer("backfill_days").notNull().default(365),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EmailMailbox = typeof emailMailboxesTable.$inferSelect;
export type EmailMessage = typeof emailMessagesTable.$inferSelect;
export type EmailExclusionRule = typeof emailExclusionRulesTable.$inferSelect;
export type EmailActivitySettings = typeof emailActivitySettingsTable.$inferSelect;
