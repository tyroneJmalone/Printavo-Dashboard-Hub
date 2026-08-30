import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Registered consumers of the AI context layer (Missive, future chatbots,
 * Zapier, ...). Each consumer authenticates its door (MCP or REST) with a
 * bearer token; only the sha256 hash is stored. Scopes list the tool names
 * the consumer may call ("*" = every tool its trust tier allows). Trust
 * tier gates which tools are even eligible: internal consumers see company
 * data, external consumers are restricted from day one (no external tools
 * are enabled yet).
 */
export const aiConsumersTable = pgTable(
  "ai_consumers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Free-text platform label: "missive", "zapier", "justcall", ... */
    platform: text("platform").notNull().default(""),
    /** sha256 hex of the bearer token — the raw token is shown once. */
    tokenHash: text("token_hash").notNull(),
    /** First characters of the raw token so admins can tell keys apart. */
    tokenPrefix: text("token_prefix").notNull(),
    /** 'internal' | 'external' — external gets no data tools yet. */
    tier: text("tier").notNull().default("internal"),
    /** Tool names this consumer may call; ["*"] = all tier-allowed tools. */
    scopes: text("scopes").array().notNull().default([]),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(60),
    active: boolean("active").notNull().default(true),
    createdByEmail: text("created_by_email"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_consumers_token_hash_ux").on(t.tokenHash),
    uniqueIndex("ai_consumers_name_ux").on(t.name),
  ],
);

export type AiConsumer = typeof aiConsumersTable.$inferSelect;
export type InsertAiConsumer = typeof aiConsumersTable.$inferInsert;

/**
 * Audit log for every AI tool call across surfaces (context layer doors
 * first; other Hub AI surfaces can adopt the same shared audit module).
 * Also carries the structured accuracy score + usage feedback the review
 * asked for — staff grade calls from the Hub admin page after the fact.
 */
export const aiAuditEventsTable = pgTable(
  "ai_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'context_mcp' | 'context_rest' | 'context_internal' | future surfaces */
    surface: text("surface").notNull(),
    consumerId: uuid("consumer_id").references(() => aiConsumersTable.id, {
      onDelete: "set null",
    }),
    /** Denormalized so the log survives consumer deletion. */
    consumerName: text("consumer_name").notNull().default(""),
    /** Set when an internal (staff-session) surface made the call. */
    staffEmail: text("staff_email"),
    tool: text("tool").notNull(),
    input: text("input").notNull().default(""),
    ok: boolean("ok").notNull(),
    errorCode: text("error_code"),
    resultSummary: text("result_summary").notNull().default(""),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Structured fact-accuracy score, set by staff review:
     * 'correct' | 'wrong_fact' | 'wrong_customer' | 'missing_data' */
    accuracy: text("accuracy"),
    /** Whether the AI output was actually used downstream:
     * 'used' | 'accepted' | 'edited' | 'rejected' | 'ignored' */
    feedbackOutcome: text("feedback_outcome"),
    feedbackNote: text("feedback_note").notNull().default(""),
    reviewedByEmail: text("reviewed_by_email"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_audit_events_created_idx").on(t.createdAt),
    index("ai_audit_events_consumer_idx").on(t.consumerId),
    index("ai_audit_events_tool_idx").on(t.tool),
  ],
);

export type AiAuditEvent = typeof aiAuditEventsTable.$inferSelect;
export type InsertAiAuditEvent = typeof aiAuditEventsTable.$inferInsert;
