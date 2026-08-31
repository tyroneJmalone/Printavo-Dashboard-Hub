import { desc, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  draftBacktestItemsTable,
  draftBacktestRunsTable,
  emailMailboxesTable,
  type DraftBacktestItem,
  type DraftBacktestRun,
  type EmailMailbox,
  type VoiceProfileTraits,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  DRAFT_MODEL,
  DRAFT_SYSTEM_PROMPT,
  gatherContextFacts,
  type ParsedWebhook,
} from "../draftPatterns/service";
import { cleanSentBody } from "../voice/profiles";
import { getReadyVoiceProfile } from "../voice/profiles";
import { logger as rootLogger } from "../logger";

/**
 * Offline drafting backtest (Task #61): dry-run the Pattern C pipeline over
 * historical inbound customer emails that a teammate ALREADY answered, so
 * fact accuracy and voice fidelity can be judged against the reply that was
 * actually sent — before go-live, without touching Missive.
 *
 * Hard boundaries:
 * - Nothing is posted to Missive. Drafts live only in draft_backtest_items.
 * - Context tool calls audit on the context_internal surface (see
 *   gatherContextFacts), so live Pattern A/B/C trial stats stay clean.
 * - Side-by-side judgment (draft vs. real reply) is HUMAN review in the Hub
 *   UI — mailbox content is never sent to an LLM for comparison.
 * - What this cannot measure: Pattern B's live note-vs-rule-draft ordering
 *   race and real accepted/edited behavior. Those still need the live week.
 */

const INBOUND_TEXT_CAP = 6000; // same cap as the live webhook pipeline
const REPLY_TEXT_CAP = 4000;
const MIN_INBOUND_CHARS = 60;
const MIN_REPLY_CHARS = 20;
/** Sample this many extra candidates per mailbox so post-clean filtering
 * still fills the requested count. */
const OVERSAMPLE_FACTOR = 3;

const GENERIC_SYSTEM_PROMPT = `You draft email replies for a screen-printing shop (MINT Prints). Write in a neutral, friendly, professional customer-service tone.

Rules:
- Use ONLY facts from CONTEXT FACTS. If the customer's question needs a fact you don't have, say the team will confirm it — never invent prices, dates, statuses, or policies.
- Reply to the customer's LATEST MESSAGE. Keep it concise.
- Never mention AI, the Hub, or that this is a draft.
- Return ONLY JSON: {"body": "the plain-text reply, with \\n\\n between paragraphs"}`;

// ── Sampling ─────────────────────────────────────────────────────────────

interface Candidate {
  threadId: string;
  subject: string;
  counterpartEmail: string;
  counterpartName: string;
  inboundAt: Date;
  inboundText: string;
  replyAt: Date;
  replyText: string;
}

/**
 * Historical inbound customer emails for one mailbox, each paired with the
 * FIRST reply the mailbox owner sent within 7 days. One candidate per
 * thread (the most recent qualifying inbound) so chatty threads don't
 * dominate; bulk/no-reply senders are excluded.
 */
async function sampleCandidates(mailbox: EmailMailbox, count: number): Promise<Candidate[]> {
  const email = mailbox.email.toLowerCase();
  const fetch = count * OVERSAMPLE_FACTOR;
  const rows = (await db.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (cm.thread_id)
        cm.thread_id AS thread_id,
        cm.subject AS subject,
        lower(cm.from_address) AS counterpart_email,
        coalesce(cm.from_name, '') AS counterpart_name,
        cm.delivered_at AS inbound_at,
        cm.body_text AS inbound_text,
        r.delivered_at AS reply_at,
        r.body_text AS reply_text
      FROM correspondence_messages cm
      JOIN LATERAL (
        SELECT r.delivered_at, r.body_text
        FROM correspondence_messages r
        WHERE r.thread_id = cm.thread_id
          AND lower(r.from_address) = ${email}
          AND r.delivered_at > cm.delivered_at
          AND r.delivered_at < cm.delivered_at + interval '7 days'
        ORDER BY r.delivered_at ASC
        LIMIT 1
      ) r ON true
      WHERE cm.mailbox_id = ${mailbox.id}
        AND lower(cm.from_address) <> ${email}
        AND lower(cm.from_address) NOT IN (SELECT lower(email) FROM email_mailboxes)
        AND cm.from_address NOT ILIKE '%no-reply%'
        AND cm.from_address NOT ILIKE '%noreply%'
        AND cm.from_address NOT ILIKE '%donotreply%'
        AND cm.from_address NOT ILIKE '%mailer-daemon%'
        AND cm.from_address NOT ILIKE 'notifications@%'
        AND length(cm.body_text) >= ${MIN_INBOUND_CHARS}
      ORDER BY cm.thread_id, cm.delivered_at DESC
    ) t
    ORDER BY random()
    LIMIT ${fetch}
  `)) as unknown as { rows: Array<Record<string, unknown>> };

  const out: Candidate[] = [];
  for (const row of rows.rows) {
    // Bodies are already HTML-stripped by the sync; cleanSentBody removes
    // quoted history so the model sees the same "latest message only" view
    // the live webhook pipeline gets. Content is NOT redacted — this mirrors
    // live Pattern C, which drafts from the customer's actual message.
    const inboundText = cleanSentBody(String(row.inbound_text ?? "")).slice(0, INBOUND_TEXT_CAP);
    const replyText = cleanSentBody(String(row.reply_text ?? "")).slice(0, REPLY_TEXT_CAP);
    if (inboundText.length < MIN_INBOUND_CHARS || replyText.length < MIN_REPLY_CHARS) continue;
    out.push({
      threadId: String(row.thread_id),
      subject: String(row.subject ?? "").slice(0, 500),
      counterpartEmail: String(row.counterpart_email ?? ""),
      counterpartName: String(row.counterpart_name ?? ""),
      inboundAt: new Date(String(row.inbound_at)),
      inboundText,
      replyAt: new Date(String(row.reply_at)),
      replyText,
    });
    if (out.length >= count) break;
  }
  return out;
}

// ── Drafting ─────────────────────────────────────────────────────────────

async function generateDraft(
  systemPrompt: string,
  parsed: ParsedWebhook,
  factsForPrompt: string,
  traits: VoiceProfileTraits | null,
): Promise<string> {
  const mailbox = parsed.mailbox!;
  const completion = await openai.chat.completions.create(
    {
      model: DRAFT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            `MAILBOX OWNER: ${mailbox.displayName ?? mailbox.email} <${mailbox.email}>`,
            `CUSTOMER: ${parsed.counterpartName || parsed.counterpartEmail}`,
            `SUBJECT: ${parsed.subject || "(no subject)"}`,
            "",
            ...(traits ? [`VOICE PROFILE:\n${JSON.stringify(traits)}`, ""] : []),
            `CONTEXT FACTS:\n${factsForPrompt || "(none — keep the reply generic and offer to check)"}`,
            "",
            `LATEST MESSAGE FROM CUSTOMER:\n${parsed.latestMessageText || "(unavailable — respond to the subject line)"}`,
          ].join("\n"),
        },
      ],
      max_completion_tokens: 900,
    },
    { timeout: 90_000 },
  );
  const raw = completion.choices[0]?.message.content ?? "{}";
  const body = String((JSON.parse(raw) as { body?: unknown }).body ?? "").trim();
  if (!body) throw new Error("draft model returned an empty body");
  return body;
}

// ── Run lifecycle ────────────────────────────────────────────────────────

/** Consider a 'running' run dead if nothing has updated it for this long
 * (covers server restarts mid-run — the in-process loop dies with the
 * process). */
const STALL_MS = 15 * 60 * 1000;

export async function getActiveBacktestRun(): Promise<DraftBacktestRun | null> {
  const [run] = await db
    .select()
    .from(draftBacktestRunsTable)
    .where(eq(draftBacktestRunsTable.status, "running"))
    .orderBy(desc(draftBacktestRunsTable.startedAt))
    .limit(1);
  if (!run) return null;
  if (Date.now() - run.updatedAt.getTime() > STALL_MS) {
    await db
      .update(draftBacktestRunsTable)
      .set({
        status: "error",
        error: "interrupted — the server restarted mid-run",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(draftBacktestRunsTable.id, run.id));
    return null;
  }
  return run;
}

export async function startBacktestRun(input: {
  samplePerMailbox: number;
  requestedByEmail: string | null;
  log?: Logger;
}): Promise<{ run: DraftBacktestRun } | { error: string }> {
  const log = input.log ?? rootLogger;
  const active = await getActiveBacktestRun();
  if (active) return { error: "a backtest run is already in progress" };

  const mailboxes = await db
    .select()
    .from(emailMailboxesTable)
    .where(eq(emailMailboxesTable.active, true));

  const ready: Array<{ mailbox: EmailMailbox; traits: VoiceProfileTraits }> = [];
  const skipped: string[] = [];
  for (const mailbox of mailboxes) {
    const profile = await getReadyVoiceProfile(mailbox.id);
    if (profile?.traits) ready.push({ mailbox, traits: profile.traits });
    else skipped.push(`${mailbox.email} (no ready voice profile)`);
  }
  if (ready.length === 0) {
    return { error: "no mailbox has a ready voice profile — generate them from the Voice Profiles page first" };
  }

  // Sample everything up front so itemsTotal is exact from the start.
  const planned: Array<{
    mailbox: EmailMailbox;
    traits: VoiceProfileTraits;
    candidate: Candidate;
  }> = [];
  for (const { mailbox, traits } of ready) {
    const candidates = await sampleCandidates(mailbox, input.samplePerMailbox);
    if (candidates.length === 0) {
      skipped.push(`${mailbox.email} (no usable answered emails in history)`);
      continue;
    }
    for (const candidate of candidates) planned.push({ mailbox, traits, candidate });
  }
  if (planned.length === 0) return { error: "no usable historical emails found to backtest" };

  const [run] = await db
    .insert(draftBacktestRunsTable)
    .values({
      status: "running",
      requestedByEmail: input.requestedByEmail,
      samplePerMailbox: input.samplePerMailbox,
      itemsTotal: planned.length,
      skippedMailboxes: skipped,
      model: DRAFT_MODEL,
    })
    .returning();
  if (!run) return { error: "failed to create the run" };

  const items = await db
    .insert(draftBacktestItemsTable)
    .values(
      planned.map((p) => ({
        runId: run.id,
        mailboxId: p.mailbox.id,
        threadId: p.candidate.threadId,
        subject: p.candidate.subject,
        counterpartEmail: p.candidate.counterpartEmail,
        counterpartName: p.candidate.counterpartName,
        inboundAt: p.candidate.inboundAt,
        inboundText: p.candidate.inboundText,
        replyAt: p.candidate.replyAt,
        replyText: p.candidate.replyText,
        status: "pending",
      })),
    )
    .returning();

  const byId = new Map(planned.map((p, i) => [items[i]!.id, p]));
  setImmediate(() => {
    void processRun(run.id, byId, log).catch((err) => {
      log.error({ err, runId: run.id }, "draft backtest run crashed");
    });
  });
  log.info(
    { runId: run.id, items: planned.length, skipped },
    "draft backtest run started",
  );
  return { run };
}

async function processRun(
  runId: string,
  planned: Map<string, { mailbox: EmailMailbox; traits: VoiceProfileTraits; candidate: Candidate }>,
  log: Logger,
): Promise<void> {
  let done = 0;
  let failed = 0;
  for (const [itemId, p] of planned) {
    const parsed: ParsedWebhook = {
      conversationId: `backtest:${itemId}`,
      subject: p.candidate.subject,
      counterpartEmail: p.candidate.counterpartEmail,
      counterpartName: p.candidate.counterpartName,
      mailbox: p.mailbox,
      latestMessageText: p.candidate.inboundText,
    };
    try {
      const facts = await gatherContextFacts(parsed, "backtest");
      const [voiceDraftBody, genericDraftBody] = await Promise.all([
        generateDraft(DRAFT_SYSTEM_PROMPT, parsed, facts.factsForPrompt, p.traits),
        generateDraft(GENERIC_SYSTEM_PROMPT, parsed, facts.factsForPrompt, null),
      ]);
      await db
        .update(draftBacktestItemsTable)
        .set({
          customerId: facts.customerId,
          customerName: facts.customerName,
          factsMarkdown: facts.factsForPrompt,
          voiceDraftBody,
          genericDraftBody,
          status: "generated",
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(draftBacktestItemsTable.id, itemId));
      done += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message.slice(0, 500) : "unknown error";
      log.warn({ err, itemId, runId }, "backtest item failed");
      await db
        .update(draftBacktestItemsTable)
        .set({ status: "error", error: message, updatedAt: new Date() })
        .where(eq(draftBacktestItemsTable.id, itemId));
    }
    await db
      .update(draftBacktestRunsTable)
      .set({ itemsDone: done, itemsFailed: failed, updatedAt: new Date() })
      .where(eq(draftBacktestRunsTable.id, runId));
  }
  await db
    .update(draftBacktestRunsTable)
    .set({
      status: "complete",
      itemsDone: done,
      itemsFailed: failed,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(draftBacktestRunsTable.id, runId));
  log.info({ runId, done, failed }, "draft backtest run complete");
}

// ── Queries for the routes ───────────────────────────────────────────────

export async function listBacktestRuns(limit: number): Promise<DraftBacktestRun[]> {
  // Sweep stalled runs so the UI never shows a zombie 'running' forever.
  await getActiveBacktestRun();
  return db
    .select()
    .from(draftBacktestRunsTable)
    .orderBy(desc(draftBacktestRunsTable.startedAt))
    .limit(limit);
}

export interface BacktestItemWithMailbox {
  item: DraftBacktestItem;
  mailboxEmail: string;
}

export async function listBacktestItems(runId: string): Promise<BacktestItemWithMailbox[]> {
  const rows = await db
    .select({ item: draftBacktestItemsTable, mailboxEmail: emailMailboxesTable.email })
    .from(draftBacktestItemsTable)
    .innerJoin(emailMailboxesTable, eq(draftBacktestItemsTable.mailboxId, emailMailboxesTable.id))
    .where(eq(draftBacktestItemsTable.runId, runId))
    .orderBy(emailMailboxesTable.email, desc(draftBacktestItemsTable.inboundAt));
  return rows;
}
