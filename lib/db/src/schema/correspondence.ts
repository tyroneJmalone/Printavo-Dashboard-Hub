import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { emailMailboxesTable } from "./emailActivity";
import { staffUsersTable } from "./staffUsers";

export const correspondenceThreadsTable = pgTable(
  "correspondence_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("missive"),
    providerThreadId: text("provider_thread_id").notNull(),
    gmailThreadId: text("gmail_thread_id"),
    subject: text("subject").notNull().default(""),
    counterpart: text("counterpart").notNull().default(""),
    counterpartEmail: text("counterpart_email").notNull().default(""),
    status: text("status").notNull().default("open"),
    snippet: text("snippet").notNull().default(""),
    webUrl: text("web_url"),
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    participants: text("participants").array().notNull().default([]),
    labels: jsonb("labels").$type<Array<{ id: string; name: string; color?: string | null }>>().notNull().default([]),
    inboxes: jsonb("inboxes").$type<Array<{ id: string; name: string }>>().notNull().default([]),
    collaborators:
      jsonb("collaborators")
        .$type<Array<{ id: string; name?: string | null; email?: string | null; kind?: string | null }>>()
        .notNull()
        .default([]),
    hydrationState: text("hydration_state").notNull().default("pending"),
    hydrationError: text("hydration_error"),
    hydratedAt: timestamp("hydrated_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("correspondence_threads_provider_id_ux").on(t.provider, t.providerThreadId),
    index("correspondence_threads_mailbox_date_ix").on(t.mailboxId, t.lastMessageAt),
    index("correspondence_threads_gmail_ix").on(t.mailboxId, t.gmailThreadId),
  ],
);

export const correspondenceMessagesTable = pgTable(
  "correspondence_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => correspondenceThreadsTable.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("missive"),
    providerMessageId: text("provider_message_id").notNull(),
    gmailMessageId: text("gmail_message_id"),
    rfcMessageId: text("rfc_message_id"),
    rawRfcMessageId: text("raw_rfc_message_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default([]),
    fromAddress: text("from_address").notNull().default(""),
    fromName: text("from_name"),
    toAddresses: text("to_addresses").array().notNull().default([]),
    ccAddresses: text("cc_addresses").array().notNull().default([]),
    bccAddresses: text("bcc_addresses").array().notNull().default([]),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    /** Sanitized on ingestion; never return raw remote HTML to the browser. */
    bodyHtml: text("body_html").notNull().default(""),
    attachments:
      jsonb("attachments")
        .$type<Array<{ id: string; filename: string; mimeType: string; size: number }>>()
        .notNull()
        .default([]),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull(),
    contentHash: text("content_hash"),
    rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("correspondence_messages_provider_id_ux").on(t.provider, t.providerMessageId),
    uniqueIndex("correspondence_messages_mailbox_rfc_ux").on(t.mailboxId, t.rfcMessageId),
    index("correspondence_messages_thread_date_ix").on(t.threadId, t.deliveredAt),
    index("correspondence_messages_mailbox_date_ix").on(t.mailboxId, t.deliveredAt),
  ],
);

export const correspondenceCommentsTable = pgTable(
  "correspondence_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => correspondenceThreadsTable.id, { onDelete: "cascade" }),
    providerCommentId: text("provider_comment_id").notNull(),
    authorProviderId: text("author_provider_id"),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    bodyText: text("body_text").notNull().default(""),
    mentionedProviderUserIds: text("mentioned_provider_user_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("correspondence_comments_provider_id_ux").on(t.providerCommentId)],
);

export const correspondenceProviderUsersTable = pgTable(
  "correspondence_provider_users",
  {
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    organizationId: text("organization_id"),
    email: text("email"),
    name: text("name"),
    rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerUserId] }), index("correspondence_provider_users_email_ix").on(t.email)],
);

export const correspondenceThreadGrantsTable = pgTable(
  "correspondence_thread_grants",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => correspondenceThreadsTable.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staffUsersTable.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("missive"),
    providerUserId: text("provider_user_id"),
    capabilities: text("capabilities")
      .array()
      .notNull()
      .default(["read", "search", "cite"]),
    active: boolean("active").notNull().default(true),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.staffId, t.source] }), index("correspondence_thread_grants_staff_ix").on(t.staffId, t.active)],
);

export const correspondenceSyncStateTable = pgTable("correspondence_sync_state", {
  id: integer("id").primaryKey().default(1),
  initialBackfillDays: integer("initial_backfill_days").notNull().default(30),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSyncStatus: text("last_sync_status").notNull().default("never"),
  lastSyncError: text("last_sync_error"),
  cursor: text("cursor"),
  syncActive: boolean("sync_active").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const correspondenceAuditTable = pgTable(
  "correspondence_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffId: uuid("staff_id").references(() => staffUsersTable.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    query: text("query"),
    sourceIds: text("source_ids").array().notNull().default([]),
    resultCount: integer("result_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("correspondence_audit_staff_date_ix").on(t.staffId, t.createdAt)],
);

export type CorrespondenceThread = typeof correspondenceThreadsTable.$inferSelect;
export type CorrespondenceMessage = typeof correspondenceMessagesTable.$inferSelect;