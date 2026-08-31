import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Logger } from "pino";
import {
  db,
  correspondenceMessagesTable,
  emailMailboxesTable,
  voiceProfilesTable,
  type EmailMailbox,
  type VoiceProfile,
  type VoiceProfileTraits,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger as rootLogger } from "../logger";

/**
 * Per-mailbox voice profiles — the offline half of voice-matched drafting
 * (Pattern C). A profile is distilled from that teammate's OWN sent
 * messages (from_address = mailbox address) and stores structured style
 * traits only. The raw sent mail never leaves the Hub: the only verbatim
 * material a profile may contain is short greeting/sign-off forms.
 */

const VOICE_MODEL = "gpt-5.6-terra";
const MAX_SAMPLE_MESSAGES = 300;
const MIN_SAMPLE_MESSAGES = 8;
const PER_MESSAGE_CHAR_CAP = 1_200;
const TOTAL_CHAR_BUDGET = 110_000;

const TraitsSchema = z.object({
  greetings: z.array(z.string().min(1).max(60)).max(8),
  signoffs: z.array(z.string().min(1).max(80)).max(8),
  formality: z.object({
    level: z.number().int().min(1).max(5),
    description: z.string().max(240),
  }),
  messageLength: z.string().max(80),
  sentenceStyle: z.string().max(400),
  punctuationHabits: z.array(z.string().max(160)).max(10),
  emojiUse: z.string().max(240),
  phrasingHabits: z.array(z.string().max(200)).max(12),
  toneDescriptors: z.array(z.string().max(50)).max(10),
  imitationNotes: z.array(z.string().max(240)).max(10),
});

/**
 * Strip quoted history from a flattened (already HTML-stripped, whitespace-
 * collapsed) sent-message body so the sample is the teammate's own words.
 */
export function cleanSentBody(text: string): string {
  let s = text;
  const markers = [
    /\bOn [A-Z][a-z]{2}.{3,120}?wrote:/s,
    /\bOn \d{1,2}\/\d{1,2}\/\d{2,4}.{3,120}?wrote:/s,
    /-{2,}\s*Original Message\s*-{2,}/i,
    /_{10,}/,
    /\bFrom:\s.{0,120}?\bSent:\s/s,
  ];
  for (const marker of markers) {
    const m = s.match(marker);
    if (m && m.index !== undefined && m.index >= 0) s = s.slice(0, m.index);
  }
  s = s
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
  if (s.length > PER_MESSAGE_CHAR_CAP) s = `${s.slice(0, PER_MESSAGE_CHAR_CAP)} …`;
  return s;
}

/**
 * Redact PII-bearing spans from a sample BEFORE it reaches the LLM: email
 * addresses, links, phone-like digit runs, dollar amounts, and long numbers
 * (order/tracking/invoice ids). The model only needs the person's phrasing —
 * customer identifiers add nothing to a style profile.
 */
export function redactSample(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "{email}")
    .replace(/(https?:\/\/|www\.)\S+/gi, "{link}")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "{phone}")
    .replace(/\$\s?\d[\d,]*(\.\d+)?/g, "{amount}")
    .replace(/\b\d{4,}\b/g, "{number}");
}

const PII_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(https?:\/\/|www\.)\S+|\+?\d[\d\s().-]{7,}\d|\$\s?\d|\b\d{4,}\b|\{email\}|\{link\}|\{phone\}|\{amount\}|\{number\}/;

/**
 * Belt-and-braces on the OUTPUT side: even though samples are redacted and
 * the prompt forbids facts, drop or scrub any generated trait that still
 * carries an email/link/phone/amount/long number. Array items are dropped
 * outright (a greeting or phrasing habit has no business containing PII);
 * free-text fields are redacted in place.
 */
export function sanitizeTraits(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  for (const key of [
    "greetings",
    "signoffs",
    "punctuationHabits",
    "phrasingHabits",
    "toneDescriptors",
    "imitationNotes",
  ]) {
    if (Array.isArray(v[key])) {
      v[key] = (v[key] as unknown[]).filter(
        (x) => typeof x !== "string" || !PII_PATTERN.test(x),
      );
    }
  }
  for (const key of ["messageLength", "sentenceStyle", "emojiUse"]) {
    if (typeof v[key] === "string") v[key] = redactSample(v[key] as string);
  }
  if (v.formality && typeof v.formality === "object") {
    const f = v.formality as Record<string, unknown>;
    if (typeof f.description === "string") f.description = redactSample(f.description);
  }
  return v;
}

interface SampleSet {
  samples: string[];
  from: Date | null;
  to: Date | null;
}

async function collectSentSamples(mailbox: EmailMailbox): Promise<SampleSet> {
  const rows = await db
    .select({
      bodyText: correspondenceMessagesTable.bodyText,
      snippet: correspondenceMessagesTable.snippet,
      deliveredAt: correspondenceMessagesTable.deliveredAt,
    })
    .from(correspondenceMessagesTable)
    .where(
      and(
        eq(correspondenceMessagesTable.mailboxId, mailbox.id),
        eq(correspondenceMessagesTable.fromAddress, mailbox.email.toLowerCase()),
      ),
    )
    .orderBy(desc(correspondenceMessagesTable.deliveredAt))
    .limit(MAX_SAMPLE_MESSAGES * 2);

  const samples: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let from: Date | null = null;
  let to: Date | null = null;
  for (const row of rows) {
    if (samples.length >= MAX_SAMPLE_MESSAGES || total >= TOTAL_CHAR_BUDGET) break;
    const cleaned = redactSample(cleanSentBody(row.bodyText || row.snippet || ""));
    if (cleaned.length < 25) continue;
    const key = cleaned.slice(0, 200);
    if (seen.has(key)) continue; // skip canned/duplicated replies
    seen.add(key);
    samples.push(cleaned);
    total += cleaned.length;
    if (!to) to = row.deliveredAt;
    from = row.deliveredAt;
  }
  return { samples, from, to };
}

const SYSTEM_PROMPT = `You are a writing-style analyst. You receive email messages ALL WRITTEN BY THE SAME PERSON and distill HOW they write into a structured style profile another assistant can use to imitate their voice. Emails, links, phone numbers, amounts, and long numbers have been replaced with {email}/{link}/{phone}/{amount}/{number} placeholders — never emit those placeholders in the profile.

Strict rules:
- Output DISTILLED STYLE ONLY. Never include customer names, company names, order details, prices, or any facts from the messages.
- The ONLY verbatim material allowed: short greeting and sign-off forms (8 words max each). Generalize recipient names to {firstName}.
- phrasingHabits describe characteristic constructions and stock phrases (short, style-level), not full sentences about specific topics.
- Return ONLY JSON with exactly these keys:
{"greetings": ["..."], "signoffs": ["..."], "formality": {"level": 1-5, "description": "..."}, "messageLength": "one-liner|short|medium|detailed (typical)", "sentenceStyle": "...", "punctuationHabits": ["..."], "emojiUse": "...", "phrasingHabits": ["..."], "toneDescriptors": ["..."], "imitationNotes": ["direct dos/don'ts for an AI imitating this voice"]}`;

async function distillTraits(samples: string[]): Promise<VoiceProfileTraits> {
  const completion = await openai.chat.completions.create(
    {
      model: VOICE_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `SENT MESSAGES (newest first, quoted history removed):\n${JSON.stringify(samples)}`,
        },
      ],
      max_completion_tokens: 1_800,
    },
    { timeout: 120_000 },
  );
  const raw = completion.choices[0]?.message.content ?? "{}";
  const parsed = TraitsSchema.safeParse(clampTraits(sanitizeTraits(JSON.parse(raw))));
  if (!parsed.success) {
    throw new Error(`voice model returned an invalid profile: ${parsed.error.message.slice(0, 300)}`);
  }
  return parsed.data;
}

/**
 * The model regularly overshoots array/string caps by a couple of items;
 * that's a quality nudge, not a correctness problem — clamp instead of
 * failing the whole generation.
 */
function clampTraits(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const arr = (key: string, maxItems: number, maxLen: number) => {
    if (Array.isArray(v[key])) {
      v[key] = (v[key] as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .slice(0, maxItems)
        .map((s) => s.slice(0, maxLen));
    }
  };
  const str = (key: string, maxLen: number) => {
    if (typeof v[key] === "string") v[key] = (v[key] as string).slice(0, maxLen);
  };
  arr("greetings", 8, 60);
  arr("signoffs", 8, 80);
  arr("punctuationHabits", 10, 160);
  arr("phrasingHabits", 12, 200);
  arr("toneDescriptors", 10, 50);
  arr("imitationNotes", 10, 240);
  str("messageLength", 80);
  str("sentenceStyle", 400);
  str("emojiUse", 240);
  if (v.formality && typeof v.formality === "object") {
    const f = v.formality as Record<string, unknown>;
    if (typeof f.description === "string") f.description = f.description.slice(0, 240);
    if (typeof f.level === "number") f.level = Math.min(5, Math.max(1, Math.round(f.level)));
  }
  return v;
}

async function upsertProfile(
  mailboxId: string,
  set: Partial<typeof voiceProfilesTable.$inferInsert>,
): Promise<VoiceProfile> {
  const [row] = await db
    .insert(voiceProfilesTable)
    .values({ mailboxId, ...set })
    .onConflictDoUpdate({
      target: voiceProfilesTable.mailboxId,
      set: { ...set, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

/** Full profile generation for one mailbox — runs in the server process. */
export async function generateVoiceProfile(
  mailboxId: string,
  requestedByEmail: string | null,
  log: Logger = rootLogger,
): Promise<VoiceProfile> {
  const [mailbox] = await db
    .select()
    .from(emailMailboxesTable)
    .where(eq(emailMailboxesTable.id, mailboxId));
  if (!mailbox) throw new Error("mailbox not found");

  await upsertProfile(mailboxId, { status: "generating", error: null, requestedByEmail });
  try {
    const { samples, from, to } = await collectSentSamples(mailbox);
    if (samples.length < MIN_SAMPLE_MESSAGES) {
      throw new Error(
        `only ${samples.length} usable sent messages for ${mailbox.email} — need at least ${MIN_SAMPLE_MESSAGES}`,
      );
    }
    const traits = await distillTraits(samples);
    const row = await upsertProfile(mailboxId, {
      status: "ready",
      traits,
      sampleMessageCount: samples.length,
      sampleFrom: from,
      sampleTo: to,
      model: VOICE_MODEL,
      error: null,
      requestedByEmail,
      generatedAt: new Date(),
    });
    log.info(
      { mailbox: mailbox.email, samples: samples.length },
      "voice profile generated",
    );
    return row;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "unknown error";
    await upsertProfile(mailboxId, { status: "error", error: message });
    log.error({ err, mailbox: mailbox.email }, "voice profile generation failed");
    throw err;
  }
}

const inFlight = new Set<string>();

/** Fire-and-forget refresh — generation runs in-process in the background. */
export function kickVoiceProfileRefresh(
  mailboxId: string,
  requestedByEmail: string | null,
  log: Logger = rootLogger,
): { started: boolean; reason?: string } {
  if (inFlight.has(mailboxId)) return { started: false, reason: "already generating" };
  inFlight.add(mailboxId);
  void generateVoiceProfile(mailboxId, requestedByEmail, log)
    .catch(() => {
      /* recorded on the row */
    })
    .finally(() => inFlight.delete(mailboxId));
  return { started: true };
}

export interface VoiceProfileWithMailbox {
  profile: VoiceProfile | null;
  mailbox: EmailMailbox;
}

/** Every active mailbox with its profile (or null when none exists yet). */
export async function listVoiceProfiles(): Promise<VoiceProfileWithMailbox[]> {
  const rows = await db
    .select({ mailbox: emailMailboxesTable, profile: voiceProfilesTable })
    .from(emailMailboxesTable)
    .leftJoin(voiceProfilesTable, eq(voiceProfilesTable.mailboxId, emailMailboxesTable.id))
    .where(eq(emailMailboxesTable.active, true));
  return rows
    .map((r) => ({ mailbox: r.mailbox, profile: r.profile }))
    .sort((a, b) => a.mailbox.email.localeCompare(b.mailbox.email));
}

/** Ready profile for one mailbox id (Pattern C drafting). */
export async function getReadyVoiceProfile(mailboxId: string): Promise<VoiceProfile | null> {
  const [row] = await db
    .select()
    .from(voiceProfilesTable)
    .where(eq(voiceProfilesTable.mailboxId, mailboxId));
  return row && row.status === "ready" && row.traits ? row : null;
}

/**
 * The `get_voice_profile` context-tool fact. Accepts a mailbox address or a
 * name fragment ("andrew"). Returns structured traits only.
 */
export async function getVoiceProfileFact(query: string): Promise<unknown> {
  const q = query.trim().toLowerCase();
  const all = await listVoiceProfiles();
  const match =
    all.find((r) => r.mailbox.email.toLowerCase() === q) ??
    all.find((r) => (r.mailbox.email.split("@")[0] ?? "").toLowerCase() === q) ??
    all.find(
      (r) =>
        r.mailbox.email.toLowerCase().startsWith(q) ||
        (r.mailbox.displayName ?? "").toLowerCase().includes(q),
    );
  if (!match) {
    return {
      found: false,
      query,
      availableMailboxes: all.map((r) => r.mailbox.email),
      note: "No team mailbox matched. Pass the mailbox address or the teammate's first name.",
    };
  }
  const { profile, mailbox } = match;
  if (!profile || profile.status !== "ready" || !profile.traits) {
    return {
      found: false,
      query,
      mailbox: { email: mailbox.email, displayName: mailbox.displayName },
      note: "This mailbox has no ready voice profile yet. A staff member can generate one from the Hub's Voice Profiles page.",
    };
  }
  return {
    found: true,
    mailbox: { email: mailbox.email, displayName: mailbox.displayName },
    generatedAt: profile.generatedAt?.toISOString() ?? null,
    sampleMessageCount: profile.sampleMessageCount,
    traits: profile.traits,
    note: "Distilled style traits only — no message content. Use these to make the draft sound like the mailbox owner; combine with context facts for substance.",
  };
}
