import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { GmailMessageMeta } from "./gmail";

/**
 * Classification: turns raw message facts into `excluded_reason`.
 *
 * The verdict is a pure function of stored facts (headers/labels/counterpart)
 * plus the exclusion rules table, so `reclassifyAll()` can retroactively
 * recompute every row with one SQL pass whenever rules change. Excluded mail
 * is never dropped — it stays visible in the "filtered" bucket.
 */

export interface ParsedMessage {
  gmailId: string;
  gmailThreadId: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddresses: string[];
  counterpartAddress: string;
  counterpartDomain: string;
  subject: string;
  internalDate: Date;
  sizeEstimate: number;
  labelIds: string[];
  hasListUnsubscribe: boolean;
  isAutoSubmitted: boolean;
}

const ADDRESS_RE = /<([^<>\s]+@[^<>\s]+)>/;
const BARE_ADDRESS_RE = /([^\s,<>"]+@[^\s,<>"]+)/;

export function extractAddress(headerValue: string | undefined): string {
  if (!headerValue) return "";
  const angled = ADDRESS_RE.exec(headerValue);
  const raw = angled?.[1] ?? BARE_ADDRESS_RE.exec(headerValue)?.[1] ?? "";
  return raw.toLowerCase().replace(/^mailto:/, "");
}

export function extractAddresses(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(",")
    .map((part) => extractAddress(part))
    .filter((a) => a.length > 0);
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

const NO_REPLY_RE = /^(no-?reply|do-?not-?reply|noreply|donotreply|mailer-daemon|postmaster|notifications?|alerts?|bounce[s]?)[@.+_-]/i;

export const GMAIL_BULK_CATEGORIES = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "CATEGORY_SOCIAL",
];

/** Labels that mean the message shouldn't be stored at all. */
export const SKIP_LABELS = new Set(["DRAFT", "CHAT", "SPAM", "TRASH"]);

export function parseGmailMessage(meta: GmailMessageMeta, mailboxEmail: string): ParsedMessage | null {
  const labels = meta.labelIds ?? [];
  if (labels.some((l) => SKIP_LABELS.has(l))) return null;
  const headers = new Map<string, string>();
  for (const h of meta.payload?.headers ?? []) headers.set(h.name.toLowerCase(), h.value);
  const fromAddress = extractAddress(headers.get("from"));
  const toAddresses = [...extractAddresses(headers.get("to")), ...extractAddresses(headers.get("cc"))];
  const mailbox = mailboxEmail.toLowerCase();
  // SENT label is authoritative when present; otherwise compare From.
  const direction: "inbound" | "outbound" =
    labels.includes("SENT") || fromAddress === mailbox ? "outbound" : "inbound";
  const counterpartAddress =
    direction === "inbound" ? fromAddress : (toAddresses.find((a) => a !== mailbox) ?? toAddresses[0] ?? "");
  const precedence = (headers.get("precedence") ?? "").toLowerCase();
  const autoSubmitted = (headers.get("auto-submitted") ?? "").toLowerCase();
  return {
    gmailId: meta.id,
    gmailThreadId: meta.threadId,
    direction,
    fromAddress,
    toAddresses,
    counterpartAddress,
    counterpartDomain: domainOf(counterpartAddress),
    subject: headers.get("subject") ?? "",
    internalDate: new Date(Number(meta.internalDate)),
    sizeEstimate: meta.sizeEstimate ?? 0,
    labelIds: labels,
    hasListUnsubscribe: headers.has("list-unsubscribe"),
    isAutoSubmitted:
      precedence === "bulk" || precedence === "list" || (autoSubmitted !== "" && autoSubmitted !== "no"),
  };
}

/**
 * The single source of truth for the verdict, as SQL — used both for
 * newly-inserted rows and for full retroactive reclassification.
 * Priority: admin rules first (they're deliberate), then automatic signals.
 * Automatic bulk signals only apply to inbound mail; a rule excludes the
 * counterpart in both directions.
 */
const VERDICT_SQL = sql`
  CASE
    WHEN EXISTS (
      SELECT 1 FROM email_exclusion_rules r
      WHERE r.kind = 'address' AND r.value = email_messages.counterpart_address
    ) THEN 'rule-address'
    WHEN EXISTS (
      SELECT 1 FROM email_exclusion_rules r
      WHERE r.kind = 'domain' AND r.value = email_messages.counterpart_domain
    ) THEN 'rule-domain'
    WHEN email_messages.direction = 'outbound'
      AND (
        (
          email_messages.from_address = 'andrew@mintprintworks.com'
          AND email_messages.subject ~* '(^proof[[:space:]]+ready|^payment[[:space:]]+received|quote[[:space:]]*&[[:space:]]*artwork[[:space:]]*/[[:space:]]*proof[[:space:]]+approved|artwork[[:space:]]*/[[:space:]]*proof[[:space:]]+approved|^contract screen print order is ready!)'
        )
        OR (
          email_messages.from_address IN ('andrew@mintprintworks.com', 'tommy@mintprintworks.com')
          AND email_messages.subject ~* '^seps[.]io[[:space:]]+has[[:space:]].*quote[[:space:]]*#[0-9]+'
        )
      )
      THEN 'printavo-notification'
    WHEN email_messages.direction = 'inbound' AND email_messages.has_list_unsubscribe THEN 'list-unsubscribe'
    WHEN email_messages.direction = 'inbound' AND email_messages.is_auto_submitted THEN 'auto-submitted'
    WHEN email_messages.direction = 'inbound' AND email_messages.from_address ~* '^(no-?reply|do-?not-?reply|noreply|donotreply|mailer-daemon|postmaster|notifications?|alerts?|bounces?)[@.+_-]' THEN 'no-reply'
    WHEN email_messages.direction = 'inbound' AND email_messages.label_ids && ARRAY['CATEGORY_PROMOTIONS','CATEGORY_UPDATES','CATEGORY_FORUMS','CATEGORY_SOCIAL']::text[] THEN 'gmail-category'
    ELSE NULL
  END
`;

/** Recompute excluded_reason for every stored message (rules changed). */
export async function reclassifyAll(): Promise<number> {
  const result = (await db.execute(
    sql`UPDATE email_messages SET excluded_reason = ${VERDICT_SQL} WHERE excluded_reason IS DISTINCT FROM (${VERDICT_SQL})`,
  )) as unknown as { rowCount?: number };
  return result.rowCount ?? 0;
}

/** Classify only the given rows (post-insert pass during sync). */
export async function classifyMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(
    sql`UPDATE email_messages SET excluded_reason = ${VERDICT_SQL} WHERE id IN (SELECT unnest(ARRAY[${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]))`,
  );
}

/** For quick tests / verify UX. */
export function isNoReplySender(address: string): boolean {
  return NO_REPLY_RE.test(address);
}
