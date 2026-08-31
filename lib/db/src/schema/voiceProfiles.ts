import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { emailMailboxesTable } from "./emailActivity";

/**
 * Per-mailbox voice profiles for voice-matched AI drafting (Pattern C).
 *
 * A profile is DISTILLED style traits only — greetings, sign-offs,
 * formality, phrasing habits — generated Hub-side from that teammate's own
 * sent messages. Message bodies and verbatim excerpts are never stored
 * here and never leave the Hub through the context-layer doors; the only
 * verbatim material allowed in traits is short greeting/sign-off forms.
 */

export interface VoiceProfileTraits {
  /** Common opening lines, e.g. "Hey {firstName}," — short forms only. */
  greetings: string[];
  /** Common closings, e.g. "Thanks!" / "Best," + name form used. */
  signoffs: string[];
  /** 1 (very casual) … 5 (very formal) plus a one-line description. */
  formality: { level: number; description: string };
  /** Typical reply length: "one-liner" | "short" | "medium" | "detailed". */
  messageLength: string;
  /** Sentence rhythm and structure habits. */
  sentenceStyle: string;
  /** Punctuation quirks: exclamation use, dashes, ellipses, etc. */
  punctuationHabits: string[];
  /** Emoji/emoticon usage description. */
  emojiUse: string;
  /** Characteristic phrasings and constructions (style, not content). */
  phrasingHabits: string[];
  /** Adjectives describing the overall tone. */
  toneDescriptors: string[];
  /** Direct guidance for an AI imitating this voice. */
  imitationNotes: string[];
}

export const voiceProfilesTable = pgTable(
  "voice_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    /** 'pending' | 'generating' | 'ready' | 'error' */
    status: text("status").notNull().default("pending"),
    traits: jsonb("traits").$type<VoiceProfileTraits | null>(),
    sampleMessageCount: integer("sample_message_count").notNull().default(0),
    sampleFrom: timestamp("sample_from", { withTimezone: true }),
    sampleTo: timestamp("sample_to", { withTimezone: true }),
    model: text("model").notNull().default(""),
    error: text("error"),
    requestedByEmail: text("requested_by_email"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("voice_profiles_mailbox_ux").on(t.mailboxId)],
);

export type VoiceProfile = typeof voiceProfilesTable.$inferSelect;
export type InsertVoiceProfile = typeof voiceProfilesTable.$inferInsert;

/**
 * One row per webhook-triggered drafting event — the measurement backbone
 * for the Pattern B/C comparison. Pattern B: webhook → Hub posts a context
 * note → a Missive AI Rule drafts from it (the note must land BEFORE the
 * rule's draft in ≥95% of conversations). Pattern C: the Hub itself creates
 * a voice-matched draft from the voice profile + context facts.
 */
export const draftPatternEventsTable = pgTable(
  "draft_pattern_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'B' (context note + Missive AI Rule) | 'C' (Hub voice-matched draft) */
    pattern: text("pattern").notNull(),
    provider: text("provider").notNull().default("missive"),
    /** Delivery idempotency: provider message id when present, else a hash
     * of the raw signed body. Unique per pattern — an at-least-once redelivery
     * or an authenticated replay can never trigger a second Missive write. */
    dedupeKey: text("dedupe_key").notNull().default(""),
    providerConversationId: text("provider_conversation_id").notNull(),
    conversationSubject: text("conversation_subject").notNull().default(""),
    mailboxId: uuid("mailbox_id").references(() => emailMailboxesTable.id, {
      onDelete: "set null",
    }),
    counterpartEmail: text("counterpart_email").notNull().default(""),
    /** Printavo customer matched from the counterpart email, if any. */
    customerId: text("customer_id"),
    customerName: text("customer_name").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    notePostedAt: timestamp("note_posted_at", { withTimezone: true }),
    noteLatencyMs: integer("note_latency_ms"),
    /** The context note content — derived facts only, for spot-checking
     * that drafts trace to the note rather than hallucination. */
    noteBody: text("note_body").notNull().default(""),
    /** True when a draft already existed when the note landed (ordering
     * rule violated before the AI rule even ran). */
    draftExistedBeforeNote: boolean("draft_existed_before_note"),
    /** Missive AI Rule draft creation time (delayed poll, Pattern B). */
    ruleDraftCreatedAt: timestamp("rule_draft_created_at", { withTimezone: true }),
    ruleDraftCheckedAt: timestamp("rule_draft_checked_at", { withTimezone: true }),
    /** Hub-created voice-matched draft time (Pattern C). */
    hubDraftCreatedAt: timestamp("hub_draft_created_at", { withTimezone: true }),
    voiceProfileUsed: boolean("voice_profile_used").notNull().default(false),
    /** 'received' | 'note_posted' | 'draft_created' | 'error' */
    status: text("status").notNull().default("received"),
    error: text("error"),
    /** Pass-criteria scoring. noteBeforeDraft is auto-computed when the
     * rule draft time is known and can be human-overridden. */
    noteBeforeDraft: boolean("note_before_draft"),
    /** Human spot-check: facts in the draft trace to the note. */
    draftUsedNote: boolean("draft_used_note"),
    reviewNote: text("review_note").notNull().default(""),
    reviewedByEmail: text("reviewed_by_email"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("draft_pattern_events_received_ix").on(t.receivedAt),
    index("draft_pattern_events_pattern_ix").on(t.pattern),
    index("draft_pattern_events_conversation_ix").on(t.providerConversationId),
    uniqueIndex("draft_pattern_events_dedupe_ux").on(t.pattern, t.dedupeKey),
  ],
);

export type DraftPatternEvent = typeof draftPatternEventsTable.$inferSelect;
export type InsertDraftPatternEvent = typeof draftPatternEventsTable.$inferInsert;
