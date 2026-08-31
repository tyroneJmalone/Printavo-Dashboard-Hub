import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  appSettingsTable,
  draftPatternEventsTable,
  emailMailboxesTable,
  type DraftPatternEvent,
  type EmailMailbox,
  type VoiceProfileTraits,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { internalCaller } from "../contextCore/auth";
import { executeContextTool } from "../contextCore/dispatch";
import { recordAiAuditEvent } from "../aiGuardrails/audit";
import {
  missiveAccountForMailbox,
  missiveAccounts,
  missiveGet,
  missivePost,
} from "../missive/client";
import { getReadyVoiceProfile } from "../voice/profiles";
import { logger as rootLogger } from "../logger";

/**
 * Pattern B / Pattern C drafting pipelines.
 *
 * Pattern B: Missive rule → webhook → the Hub posts a CONTEXT NOTE (an
 * internal comment, never customer-visible) on the conversation → a Missive
 * AI Rule drafts from it. The measurement contract: the note must land
 * before the rule's draft in ≥95% of conversations, and drafts must
 * demonstrably use note content.
 *
 * Pattern C: same webhook, but the Hub itself creates the draft — context
 * facts + the mailbox owner's voice profile — so Andrew's drafts sound like
 * Andrew. Drafts only; a human always reviews and sends.
 */

export const DRAFT_MODEL = "gpt-5.6-terra";
const RULE_DRAFT_CHECK_DELAYS_MS = [4 * 60 * 1000, 12 * 60 * 1000];

// ── Webhook signature secret (app_settings) ─────────────────────────────

const WEBHOOK_SETTINGS_KEY = "missive_webhook";

export async function getWebhookSecret(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, WEBHOOK_SETTINGS_KEY));
  const value = (row?.value ?? null) as { secret?: string } | null;
  return typeof value?.secret === "string" && value.secret.length >= 16 ? value.secret : null;
}

export async function rotateWebhookSecret(): Promise<string> {
  const secret = randomBytes(24).toString("hex");
  const value = { secret, rotatedAt: new Date().toISOString() };
  await db
    .insert(appSettingsTable)
    .values({ key: WEBHOOK_SETTINGS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
  return secret;
}

/** X-Hook-Signature: sha256=<HMAC-SHA256 hexdigest of the raw body>. */
export function verifyMissiveSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const hex = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(hex, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// ── Webhook payload parsing ──────────────────────────────────────────────

export interface ParsedWebhook {
  conversationId: string;
  subject: string;
  counterpartEmail: string;
  counterpartName: string;
  mailbox: EmailMailbox | null;
  latestMessageText: string;
}

function addressList(value: unknown): Array<{ address: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((f) => {
      const rec = f as { address?: unknown; name?: unknown };
      return {
        address: typeof rec?.address === "string" ? rec.address.toLowerCase() : "",
        name: typeof rec?.name === "string" ? rec.name : "",
      };
    })
    .filter((f) => f.address.includes("@"));
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<blockquote[\s\S]*$/i, " ") // drop quoted history
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Missive rule webhooks post `{ rule, conversation, message?, comment? }`.
 * Everything here is defensive — payload shapes vary by trigger type.
 */
export async function parseWebhookPayload(payload: unknown): Promise<ParsedWebhook | null> {
  const root = payload as {
    conversation?: { id?: unknown; subject?: unknown; latest_message_subject?: unknown };
    message?: Record<string, unknown>;
  };
  const conversationId =
    typeof root?.conversation?.id === "string" ? root.conversation.id : null;
  if (!conversationId) return null;
  const subject =
    (typeof root.conversation?.subject === "string" && root.conversation.subject) ||
    (typeof root.conversation?.latest_message_subject === "string" &&
      root.conversation.latest_message_subject) ||
    "";

  const mailboxes = await db
    .select()
    .from(emailMailboxesTable)
    .where(eq(emailMailboxesTable.active, true));
  const tracked = new Map(mailboxes.map((m) => [m.email.toLowerCase(), m]));

  const message = root.message ?? {};
  const from = addressList([message.from_field])[0] ?? { address: "", name: "" };
  const recipients = [
    ...addressList(message.to_fields),
    ...addressList(message.cc_fields),
  ];

  let mailbox: EmailMailbox | null = null;
  let counterpart = { address: "", name: "" };
  if (from.address && tracked.has(from.address)) {
    // Outbound message triggered the rule — counterpart is the recipient.
    mailbox = tracked.get(from.address) ?? null;
    counterpart = recipients.find((r) => !tracked.has(r.address)) ?? counterpart;
  } else {
    mailbox = recipients.map((r) => tracked.get(r.address)).find(Boolean) ?? null;
    counterpart = from;
  }

  const rawBody =
    typeof message.body === "string"
      ? message.body
      : typeof message.preview === "string"
        ? message.preview
        : "";

  return {
    conversationId,
    subject,
    counterpartEmail: counterpart.address,
    counterpartName: counterpart.name,
    mailbox,
    latestMessageText: stripHtmlToText(rawBody).slice(0, 6000),
  };
}

// ── Context facts ────────────────────────────────────────────────────────

export interface ContextFacts {
  customerId: string | null;
  customerName: string;
  noteMarkdown: string;
  factsForPrompt: string;
}

/**
 * "backtest" = the offline drafting backtest dry-running this pipeline over
 * historical email. It audits on the context_internal surface so backtest
 * tool calls never pollute the live Pattern B/C trial stats.
 */
export async function gatherContextFacts(
  parsed: ParsedWebhook,
  pattern: "B" | "C" | "backtest",
): Promise<ContextFacts> {
  const caller = internalCaller(
    null,
    pattern === "B"
      ? "Pattern B webhook"
      : pattern === "C"
        ? "Pattern C voice draft"
        : "Draft backtest",
  );
  const surface =
    pattern === "B" ? "pattern_b" : pattern === "C" ? "pattern_c" : "context_internal";
  const lines: string[] = [];
  let customerId: string | null = null;
  let customerName = "";

  if (!parsed.counterpartEmail) {
    lines.push("_No counterpart email in this conversation — no customer lookup possible._");
  } else {
    const lookup = await executeContextTool({
      caller,
      surface,
      tool: "lookup_customer",
      args: { query: parsed.counterpartEmail },
    });
    const candidates =
      lookup.ok && Array.isArray((lookup.data as { candidates?: unknown[] })?.candidates)
        ? ((lookup.data as { candidates: Array<Record<string, unknown>> }).candidates ?? [])
        : [];
    const exact = candidates.filter((c) => c.matchType === "exact");
    const chosen = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
    if (!chosen) {
      lines.push(
        candidates.length === 0
          ? `_No Printavo customer matched ${parsed.counterpartEmail}._`
          : `_${candidates.length} possible customer matches for ${parsed.counterpartEmail} — none certain enough to act on._`,
      );
    } else {
      customerId = String(chosen.customerId ?? "") || null;
      customerName = String(chosen.companyName ?? chosen.contactName ?? "");
    }
  }

  if (customerId) {
    const summary = await executeContextTool({
      caller,
      surface,
      tool: "get_customer_summary",
      args: { customerId },
    });
    if (summary.ok && (summary.data as { found?: boolean })?.found) {
      const data = summary.data as {
        customer: {
          companyName: string;
          primaryContact: { name: string | null; email: string | null } | null;
        };
        stats: {
          totalOrders: number;
          lifetimeInvoiceTotal: number;
          outstandingBalance: number;
          lastOrderAt: string | null;
        };
        recentOrders: Array<{
          visualId: string | null;
          orderType: string;
          statusName: string | null;
          nickname: string | null;
          total: number;
          createdAt: string | null;
        }>;
      };
      customerName = data.customer.companyName || customerName;
      const contact = data.customer.primaryContact;
      lines.push(
        `**Customer:** ${data.customer.companyName}` +
          (contact?.name ? ` — primary contact ${contact.name}${contact.email ? ` <${contact.email}>` : ""}` : ""),
      );
      lines.push(
        `**History:** ${data.stats.totalOrders} orders, $${data.stats.lifetimeInvoiceTotal.toFixed(2)} lifetime invoiced, $${data.stats.outstandingBalance.toFixed(2)} outstanding.`,
      );
      if (data.recentOrders.length) {
        lines.push("**Recent orders:**");
        for (const o of data.recentOrders.slice(0, 5)) {
          const date = o.createdAt ? o.createdAt.slice(0, 10) : "?";
          lines.push(
            `- #${o.visualId ?? "?"} (${o.orderType}) — ${o.statusName ?? "no status"} — $${o.total.toFixed(2)}${o.nickname ? ` — “${o.nickname}”` : ""} — ${date}`,
          );
        }
      }
    }
  }

  if (parsed.subject) {
    const knowledge = await executeContextTool({
      caller,
      surface,
      tool: "search_knowledge",
      args: { query: parsed.subject.slice(0, 200) },
    });
    const entries =
      knowledge.ok && Array.isArray((knowledge.data as { entries?: unknown[] })?.entries)
        ? ((knowledge.data as { entries: Array<Record<string, unknown>> }).entries ?? [])
        : [];
    if (entries.length) {
      lines.push("**Knowledge base:**");
      for (const e of entries.slice(0, 2)) {
        const title = String(e.title ?? e.question ?? "entry");
        const answer = String(e.answer ?? e.content ?? "").slice(0, 300);
        if (answer) lines.push(`- ${title}: ${answer}`);
      }
    }
  }

  const factsForPrompt = lines.join("\n");
  const noteMarkdown = [
    `**Printavo Hub context** — auto-posted for AI drafting. Facts as of ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    "",
    factsForPrompt || "_No Hub facts available for this conversation._",
    "",
    "_Drafts should only rely on facts from this note. Verify anything else before sending._",
  ].join("\n");

  return { customerId, customerName, noteMarkdown, factsForPrompt };
}

// ── Missive draft helpers ────────────────────────────────────────────────

interface MissiveDraftListItem {
  id: string;
  created_at?: number;
  author?: { email?: string | null } | null;
  from_field?: { address?: string | null } | null;
}

async function listConversationDrafts(
  conversationId: string,
  accountToken: string | undefined,
): Promise<MissiveDraftListItem[]> {
  const res = await missiveGet<{ drafts?: MissiveDraftListItem[] }>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/drafts?limit=10`,
    accountToken,
  );
  return Array.isArray(res.drafts) ? res.drafts : [];
}

function draftCreatedAtMs(draft: MissiveDraftListItem): number | null {
  return typeof draft.created_at === "number" ? draft.created_at * 1000 : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ── Event pipelines ──────────────────────────────────────────────────────

async function updateEvent(
  id: string,
  set: Partial<typeof draftPatternEventsTable.$inferInsert>,
): Promise<void> {
  await db
    .update(draftPatternEventsTable)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(draftPatternEventsTable.id, id));
}

/**
 * Entry point from the webhook routes. Records the event and processes it
 * asynchronously so Missive gets its 200 well inside the 15s timeout.
 */
/**
 * Delivery idempotency key: Missive's message id when the payload carries
 * one, otherwise a hash of the raw signed body. Either way, an at-least-once
 * redelivery or a replayed capture maps to the same key.
 */
export function webhookDedupeKey(payload: unknown, rawBody: Buffer | string): string {
  const messageId = (payload as { message?: { id?: unknown } })?.message?.id;
  if (typeof messageId === "string" && messageId.length > 0) return `msg:${messageId}`;
  return `raw:${createHash("sha256").update(rawBody).digest("hex")}`;
}

export async function receivePatternWebhook(
  pattern: "B" | "C",
  payload: unknown,
  rawBody: Buffer | string,
  log: Logger = rootLogger,
): Promise<{ eventId: string | null; accepted: boolean; reason?: string }> {
  const parsed = await parseWebhookPayload(payload);
  if (!parsed) return { eventId: null, accepted: false, reason: "no conversation id in payload" };
  const receivedAt = new Date();
  // Unique (pattern, dedupe_key) index makes redeliveries/replays no-ops
  // BEFORE any Missive write can happen — the insert is the gate.
  const [event] = await db
    .insert(draftPatternEventsTable)
    .values({
      pattern,
      dedupeKey: webhookDedupeKey(payload, rawBody),
      providerConversationId: parsed.conversationId,
      conversationSubject: parsed.subject.slice(0, 500),
      mailboxId: parsed.mailbox?.id ?? null,
      counterpartEmail: parsed.counterpartEmail,
      receivedAt,
      status: "received",
    })
    .onConflictDoNothing({
      target: [draftPatternEventsTable.pattern, draftPatternEventsTable.dedupeKey],
    })
    .returning();
  if (!event) {
    log.info({ pattern, conversationId: parsed.conversationId }, "duplicate webhook delivery ignored");
    return { eventId: null, accepted: false, reason: "duplicate delivery" };
  }
  setImmediate(() => {
    void processPatternEvent(event.id, pattern, parsed, receivedAt, log).catch((err) => {
      log.error({ err, eventId: event.id, pattern }, "draft pattern pipeline failed");
    });
  });
  return { eventId: event.id, accepted: true };
}

async function processPatternEvent(
  eventId: string,
  pattern: "B" | "C",
  parsed: ParsedWebhook,
  receivedAt: Date,
  log: Logger,
): Promise<void> {
  try {
    const facts = await gatherContextFacts(parsed, pattern);
    await updateEvent(eventId, {
      customerId: facts.customerId,
      customerName: facts.customerName,
    });
    if (pattern === "B") {
      await runPatternB(eventId, parsed, facts, receivedAt, log);
    } else {
      await runPatternC(eventId, parsed, facts, log);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "unknown error";
    await updateEvent(eventId, { status: "error", error: message });
    await recordAiAuditEvent({
      surface: pattern === "B" ? "pattern_b" : "pattern_c",
      consumerName: pattern === "B" ? "Pattern B webhook" : "Pattern C voice draft",
      tool: pattern === "B" ? "context_note" : "voice_draft",
      input: { conversationId: parsed.conversationId, subject: parsed.subject },
      ok: false,
      errorCode: "PIPELINE_ERROR",
      resultSummary: message,
    });
    throw err;
  }
}

async function runPatternB(
  eventId: string,
  parsed: ParsedWebhook,
  facts: ContextFacts,
  receivedAt: Date,
  log: Logger,
): Promise<void> {
  const primaryToken = missiveAccounts()[0]?.token;
  await missivePost(
    "/v1/posts",
    {
      posts: {
        conversation: parsed.conversationId,
        username: "Printavo Hub",
        markdown: facts.noteMarkdown.slice(0, 7900),
        // Missive requires a notification object on every post.
        notification: {
          title: "Printavo Hub context",
          body: `Customer context for: ${parsed.subject || "conversation"}`.slice(0, 200),
        },
      },
    },
    primaryToken,
  );
  const notePostedAt = new Date();
  const noteLatencyMs = notePostedAt.getTime() - receivedAt.getTime();
  await updateEvent(eventId, {
    status: "note_posted",
    notePostedAt,
    noteLatencyMs,
    noteBody: facts.noteMarkdown,
  });
  await recordAiAuditEvent({
    surface: "pattern_b",
    consumerName: "Pattern B webhook",
    tool: "context_note",
    input: { conversationId: parsed.conversationId, counterpart: parsed.counterpartEmail },
    ok: true,
    resultSummary: `note posted in ${noteLatencyMs}ms`,
    latencyMs: noteLatencyMs,
  });

  // Ordering check #1 — was a draft already there before the note landed?
  try {
    const drafts = await listConversationDrafts(parsed.conversationId, primaryToken);
    const existedBefore = drafts.some((d) => {
      const ms = draftCreatedAtMs(d);
      return ms !== null && ms < notePostedAt.getTime();
    });
    await updateEvent(eventId, {
      draftExistedBeforeNote: existedBefore,
      ...(existedBefore ? { noteBeforeDraft: false } : {}),
    });
  } catch (err) {
    log.warn({ err, eventId }, "pattern B initial draft check failed");
  }

  // Delayed checks — capture when the Missive AI Rule's draft appeared.
  for (const delay of RULE_DRAFT_CHECK_DELAYS_MS) {
    setTimeout(() => {
      void checkRuleDraft(eventId, parsed.conversationId, receivedAt, notePostedAt, log);
    }, delay);
  }
}

async function checkRuleDraft(
  eventId: string,
  conversationId: string,
  receivedAt: Date,
  notePostedAt: Date,
  log: Logger,
): Promise<void> {
  try {
    const [event] = await db
      .select()
      .from(draftPatternEventsTable)
      .where(eq(draftPatternEventsTable.id, eventId));
    if (!event || event.ruleDraftCreatedAt) return; // already captured
    const drafts = await listConversationDrafts(
      conversationId,
      missiveAccounts()[0]?.token,
    );
    const candidates = drafts
      .map((d) => draftCreatedAtMs(d))
      .filter((ms): ms is number => ms !== null && ms >= receivedAt.getTime() - 60_000)
      .sort((a, b) => a - b);
    const ruleDraftMs = candidates[0];
    await updateEvent(eventId, {
      ruleDraftCheckedAt: new Date(),
      ...(ruleDraftMs
        ? {
            ruleDraftCreatedAt: new Date(ruleDraftMs),
            // Auto-score; staff can override from the Hub.
            ...(event.noteBeforeDraft === null
              ? { noteBeforeDraft: notePostedAt.getTime() < ruleDraftMs }
              : {}),
          }
        : {}),
    });
  } catch (err) {
    log.warn({ err, eventId }, "pattern B rule-draft check failed");
  }
}

export const DRAFT_SYSTEM_PROMPT = `You draft email replies for a screen-printing shop (MINT Prints). You are drafting AS the mailbox owner, in their personal writing voice.

Rules:
- Use ONLY facts from CONTEXT FACTS. If the customer's question needs a fact you don't have, say the team will confirm it — never invent prices, dates, statuses, or policies.
- Follow VOICE PROFILE for tone, greeting, sign-off, sentence rhythm, and formality. The draft should read like the owner wrote it.
- Reply to the customer's LATEST MESSAGE. Be as brief as the owner usually is.
- Never mention AI, the Hub, or that this is a draft.
- Return ONLY JSON: {"body": "the plain-text reply, with \\n\\n between paragraphs"}`;

async function runPatternC(
  eventId: string,
  parsed: ParsedWebhook,
  facts: ContextFacts,
  log: Logger,
): Promise<void> {
  if (!parsed.mailbox) {
    throw new Error("no tracked mailbox recognized in the webhook payload");
  }
  if (!parsed.counterpartEmail) {
    throw new Error("no counterpart email to address the draft to");
  }
  const profile = await getReadyVoiceProfile(parsed.mailbox.id);
  if (!profile?.traits) {
    throw new Error(
      `no ready voice profile for ${parsed.mailbox.email} — generate one from the Voice Profiles page`,
    );
  }
  const account = missiveAccountForMailbox(parsed.mailbox.email, parsed.mailbox.displayName);

  let latest = parsed.latestMessageText;
  if (!latest) {
    latest = await fetchLatestInboundText(
      parsed.conversationId,
      parsed.mailbox.email,
      account.token,
    );
  }

  const started = Date.now();
  const completion = await openai.chat.completions.create(
    {
      model: DRAFT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DRAFT_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `MAILBOX OWNER: ${parsed.mailbox.displayName ?? parsed.mailbox.email} <${parsed.mailbox.email}>`,
            `CUSTOMER: ${parsed.counterpartName || parsed.counterpartEmail}`,
            `SUBJECT: ${parsed.subject || "(no subject)"}`,
            "",
            `VOICE PROFILE:\n${JSON.stringify(profile.traits satisfies VoiceProfileTraits)}`,
            "",
            `CONTEXT FACTS:\n${facts.factsForPrompt || "(none — keep the reply generic and offer to check)"}`,
            "",
            `LATEST MESSAGE FROM CUSTOMER:\n${latest || "(unavailable — respond to the subject line)"}`,
          ].join("\n"),
        },
      ],
      max_completion_tokens: 900,
    },
    { timeout: 60_000 },
  );
  const raw = completion.choices[0]?.message.content ?? "{}";
  const body = String((JSON.parse(raw) as { body?: unknown }).body ?? "").trim();
  if (!body) throw new Error("draft model returned an empty body");

  const subject = parsed.subject
    ? /^re:/i.test(parsed.subject)
      ? parsed.subject
      : `Re: ${parsed.subject}`
    : "Re: your email";
  await missivePost(
    "/v1/drafts",
    {
      drafts: {
        subject,
        body: textToHtml(body),
        conversation: parsed.conversationId,
        from_field: {
          address: parsed.mailbox.email,
          ...(parsed.mailbox.displayName ? { name: parsed.mailbox.displayName } : {}),
        },
        to_fields: [
          {
            address: parsed.counterpartEmail,
            ...(parsed.counterpartName ? { name: parsed.counterpartName } : {}),
          },
        ],
      },
    },
    account.token,
  );
  const hubDraftCreatedAt = new Date();
  await updateEvent(eventId, {
    status: "draft_created",
    hubDraftCreatedAt,
    voiceProfileUsed: true,
    noteBody: facts.noteMarkdown,
  });
  await recordAiAuditEvent({
    surface: "pattern_c",
    consumerName: "Pattern C voice draft",
    tool: "voice_draft",
    input: {
      conversationId: parsed.conversationId,
      mailbox: parsed.mailbox.email,
      counterpart: parsed.counterpartEmail,
    },
    ok: true,
    resultSummary: `voice-matched draft created for ${parsed.mailbox.email}`,
    latencyMs: Date.now() - started,
  });
  log.info(
    { eventId, mailbox: parsed.mailbox.email },
    "pattern C voice-matched draft created",
  );
}

/** Latest inbound message text straight from Missive (webhook body absent). */
async function fetchLatestInboundText(
  conversationId: string,
  mailboxEmail: string,
  accountToken: string | undefined,
): Promise<string> {
  try {
    const list = await missiveGet<{
      messages?: Array<{ id: string; from_field?: { address?: string | null } | null }>;
    }>(`/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=5`, accountToken);
    const inbound = (list.messages ?? []).find(
      (m) => (m.from_field?.address ?? "").toLowerCase() !== mailboxEmail.toLowerCase(),
    );
    if (!inbound) return "";
    const full = await missiveGet<{ messages?: { body?: string; preview?: string } }>(
      `/v1/messages/${encodeURIComponent(inbound.id)}`,
      accountToken,
    );
    return stripHtmlToText(full.messages?.body ?? full.messages?.preview ?? "").slice(0, 6000);
  } catch {
    return "";
  }
}

// ── Measurement summary ──────────────────────────────────────────────────

export async function listPatternEvents(
  pattern: "B" | "C" | undefined,
  limit: number,
): Promise<DraftPatternEvent[]> {
  if (pattern) {
    return db
      .select()
      .from(draftPatternEventsTable)
      .where(eq(draftPatternEventsTable.pattern, pattern))
      .orderBy(desc(draftPatternEventsTable.receivedAt))
      .limit(limit);
  }
  return db
    .select()
    .from(draftPatternEventsTable)
    .orderBy(desc(draftPatternEventsTable.receivedAt))
    .limit(limit);
}
