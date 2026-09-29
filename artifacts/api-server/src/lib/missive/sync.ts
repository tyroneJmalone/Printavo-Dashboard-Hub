import { createHash } from "node:crypto";
import {
  db,
  pool,
  correspondenceCommentsTable,
  correspondenceMessagesTable,
  correspondenceProviderUsersTable,
  correspondenceSyncStateTable,
  correspondenceThreadGrantsTable,
  correspondenceThreadsTable,
  emailMailboxesTable,
  staffUsersTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { missiveAccounts, missiveGet, missivePath } from "./client";
import { normalizeMessageId } from "./accessPolicy";
import { htmlToText } from "../emailActivity/gmail";

type Json = Record<string, unknown>;

const CONVERSATION_LIMIT = 50;
const ITEM_LIMIT = 10;
const MAX_PAGES = 250;
let active = false;
let connectorBlockedUntil = 0;

export function isMissiveSyncActive(): boolean {
  return active;
}

export function isMissiveConnectorReady(): boolean {
  return Date.now() >= connectorBlockedUntil;
}

export async function purgeCorrespondenceRetention(): Promise<void> {
  const policy = await pool.query<{ retention_days: number }>(
    "SELECT retention_days FROM email_access_settings WHERE id=1",
  );
  const retentionDays = policy.rows[0]?.retention_days ?? 3650;
  await pool.query(
    `DELETE FROM correspondence_messages
      WHERE delivered_at < now() - ($1::int * interval '1 day')`,
    [retentionDays],
  );
  await pool.query(
    `DELETE FROM correspondence_comments
      WHERE created_at < now() - ($1::int * interval '1 day')`,
    [retentionDays],
  );
  await pool.query(
    `DELETE FROM correspondence_threads t
      WHERE NOT EXISTS (
        SELECT 1 FROM correspondence_messages m WHERE m.thread_id = t.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM correspondence_comments c WHERE c.thread_id = t.id
      )`,
  );
  await pool.query(
    `DELETE FROM correspondence_audit
      WHERE created_at < now() - ($1::int * interval '1 day')`,
    [retentionDays],
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function itemArray(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.filter((item): item is Json => typeof item === "object" && item !== null)
    : [];
}

function addressList(value: unknown): string[] {
  return itemArray(value)
    .map((item) => stringValue(item.address ?? item.email).trim().toLowerCase())
    .filter(Boolean);
}

function epochDate(value: unknown, fallback = new Date()): Date {
  const n = numberValue(value);
  if (n == null) return fallback;
  const ms = n < 10_000_000_000 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function safeMetadata(value: Json): Json {
  const copy = { ...value };
  delete copy.body;
  delete copy.raw;
  delete copy.html;
  return copy;
}

async function listTimed(
  basePath: string,
  rootKey: string,
  timestampKey: string,
  accountToken?: string,
): Promise<Json[]> {
  const rows: Json[] = [];
  let until: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await missiveGet<Json>(
      missivePath(basePath, { limit: ITEM_LIMIT, until }),
      accountToken,
    );
    const items = itemArray(payload[rootKey]);
    rows.push(...items);
    if (items.length < ITEM_LIMIT || items.length === 0) break;
    const oldest = numberValue(items[items.length - 1]?.[timestampKey]);
    if (oldest == null || oldest === until) break;
    until = oldest;
  }
  return rows;
}

async function fullMessage(messageId: string, accountToken?: string): Promise<Json | null> {
  const payload = await missiveGet<Json>(
    `/v1/messages/${encodeURIComponent(messageId)}`,
    accountToken,
  );
  const messages = payload.messages;
  if (Array.isArray(messages)) return itemArray(messages)[0] ?? null;
  return typeof messages === "object" && messages !== null ? (messages as Json) : null;
}

function extractUserIds(value: Json): string[] {
  const ids = new Set<string>();
  for (const key of ["users", "assignees", "collaborators"]) {
    for (const item of itemArray(value[key])) {
      const id = stringValue(item.id ?? item.user_id);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function extractMentionIds(comment: Json): string[] {
  const ids = new Set<string>();
  for (const key of ["mentions", "mentioned_users", "users"]) {
    for (const item of itemArray(comment[key])) {
      const id = stringValue(item.id ?? item.user_id);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

async function syncDirectory(accountToken?: string): Promise<Map<string, string>> {
  const organizations = itemArray(
    (await missiveGet<Json>("/v1/organizations", accountToken)).organizations,
  );
  const staffRows = await db.select().from(staffUsersTable);
  const staffByEmail = new Map(staffRows.map((row) => [row.email.toLowerCase(), row.id]));
  const staffByProviderId = new Map<string, string>();

  for (const organization of organizations) {
    const organizationId = stringValue(organization.id);
    if (!organizationId) continue;
    let offset = 0;
    for (;;) {
      const payload = await missiveGet<Json>(
        missivePath("/v1/users", { organization: organizationId, limit: 200, offset }),
        accountToken,
      );
      const users = itemArray(payload.users);
      for (const user of users) {
        const providerUserId = stringValue(user.id);
        if (!providerUserId) continue;
        const email = stringValue(user.email ?? user.address).trim().toLowerCase() || null;
        await db
          .insert(correspondenceProviderUsersTable)
          .values({
            provider: "missive",
            providerUserId,
            organizationId,
            email,
            name: stringValue(user.name) || null,
            rawMetadata: safeMetadata(user),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              correspondenceProviderUsersTable.provider,
              correspondenceProviderUsersTable.providerUserId,
            ],
            set: {
              organizationId,
              email,
              name: stringValue(user.name) || null,
              rawMetadata: safeMetadata(user),
              updatedAt: new Date(),
            },
          });
        if (email && staffByEmail.has(email)) {
          staffByProviderId.set(providerUserId, staffByEmail.get(email)!);
        }
      }
      if (users.length < 200) break;
      offset += users.length;
    }
  }
  return staffByProviderId;
}

/** Merge missive user→staff mappings discovered through each account. */
function mergeDirectories(target: Map<string, string>, source: Map<string, string>): void {
  for (const [providerId, staffId] of source) {
    if (!target.has(providerId)) target.set(providerId, staffId);
  }
}

async function findMailboxId(messages: Json[]): Promise<string | null> {
  const mailboxes = await db
    .select({ id: emailMailboxesTable.id, email: emailMailboxesTable.email })
    .from(emailMailboxesTable)
    .orderBy(asc(emailMailboxesTable.createdAt));
  const byEmail = new Map(mailboxes.map((row) => [row.email.toLowerCase(), row.id]));
  const matched = new Set<string>();
  for (const message of messages) {
    const addresses = [
      ...addressList(message.from_field ? [message.from_field] : []),
      ...addressList(message.to_fields),
      ...addressList(message.cc_fields),
      ...addressList(message.bcc_fields),
    ];
    for (const address of addresses) {
      const mailboxId = byEmail.get(address);
      if (mailboxId) matched.add(mailboxId);
    }
  }
  // Never guess between multiple tracked mailboxes. An ambiguous thread may
  // otherwise inherit the less restrictive mailbox's policy.
  return matched.size === 1 ? [...matched][0] : null;
}

async function upsertMessage(threadId: string, mailboxId: string, message: Json): Promise<void> {
  const providerMessageId = stringValue(message.id);
  if (!providerMessageId) return;
  const rawRfc = stringValue(message.email_message_id ?? message.message_id) || null;
  const rfcMessageId = normalizeMessageId(rawRfc);
  const bodyHtmlRemote = stringValue(message.body);
  const bodyText = htmlToText(bodyHtmlRemote);
  const deliveredAt = epochDate(message.delivered_at ?? message.created_at);
  const fromField =
    typeof message.from_field === "object" && message.from_field !== null
      ? (message.from_field as Json)
      : {};
  const attachments = itemArray(message.attachments).map((attachment) => ({
    id: stringValue(attachment.id),
    filename: stringValue(attachment.filename ?? attachment.name) || "attachment",
    mimeType: stringValue(attachment.media_type ?? attachment.mime_type) || "application/octet-stream",
    size: numberValue(attachment.size) ?? 0,
  }));
  const values = {
    threadId,
    mailboxId,
    provider: "missive",
    providerMessageId,
    rfcMessageId,
    rawRfcMessageId: rawRfc,
    inReplyTo: normalizeMessageId(stringValue(message.in_reply_to)) ?? null,
    references: itemArray(message.references).length
      ? itemArray(message.references)
          .map((item) => normalizeMessageId(stringValue(item.id ?? item.value)))
          .filter((value): value is string => Boolean(value))
      : stringValue(message.references)
          .split(/\s+/)
          .map(normalizeMessageId)
          .filter((value): value is string => Boolean(value)),
    fromAddress: stringValue(fromField.address).toLowerCase(),
    fromName: stringValue(fromField.name) || null,
    toAddresses: addressList(message.to_fields),
    ccAddresses: addressList(message.cc_fields),
    bccAddresses: addressList(message.bcc_fields),
    subject: stringValue(message.subject),
    snippet: stringValue(message.preview) || bodyText.slice(0, 300),
    bodyText,
    // Remote HTML is intentionally not persisted until a battle-tested
    // sanitizer is introduced. Only plain text is stored.
    bodyHtml: "",
    attachments,
    deliveredAt,
    contentHash: createHash("sha256").update(bodyText).digest("hex"),
    rawMetadata: safeMetadata(message),
    updatedAt: new Date(),
  };

  const existing = await pool.query<{ id: string }>(
    `
      SELECT id FROM correspondence_messages
      WHERE provider = 'missive' AND provider_message_id = $1
         OR ($2::text IS NOT NULL AND mailbox_id = $3::uuid AND rfc_message_id = $2)
      ORDER BY (provider_message_id = $1) DESC
      LIMIT 1
    `,
    [providerMessageId, rfcMessageId, mailboxId],
  );
  if (existing.rows[0]) {
    await db
      .update(correspondenceMessagesTable)
      .set(values)
      .where(eq(correspondenceMessagesTable.id, existing.rows[0].id));
  } else {
    await db.insert(correspondenceMessagesTable).values(values);
  }
}

async function hydrateConversation(
  conversation: Json,
  staffByProviderId: Map<string, string>,
  bounds?: { from?: number; to?: number },
  accountToken?: string,
): Promise<boolean> {
  const providerThreadId = stringValue(conversation.id);
  if (!providerThreadId) return false;
  const listedMessages = await listTimed(
    `/v1/conversations/${encodeURIComponent(providerThreadId)}/messages`,
    "messages",
    "delivered_at",
    accountToken,
  );
  const mailboxId = await findMailboxId(listedMessages);
  if (!mailboxId) return false;
  const messages: Json[] = [];
  for (const listed of listedMessages) {
    const id = stringValue(listed.id);
    if (!id) continue;
    const full = (await fullMessage(id, accountToken)) ?? listed;
    const delivered = epochDate(full.delivered_at ?? full.created_at).getTime();
    if (bounds?.from != null && delivered < bounds.from) continue;
    if (bounds?.to != null && delivered >= bounds.to) continue;
    messages.push(full);
  }
  if (messages.length === 0) return false;

  const comments = await listTimed(
    `/v1/conversations/${encodeURIComponent(providerThreadId)}/comments`,
    "comments",
    "created_at",
    accountToken,
  );
  const newest = messages[0] ?? {};
  const oldest = messages[messages.length - 1] ?? newest;
  const fromField =
    typeof newest.from_field === "object" && newest.from_field !== null
      ? (newest.from_field as Json)
      : {};
  const labels = itemArray(conversation.shared_labels).map((label) => ({
    id: stringValue(label.id),
    name: stringValue(label.name ?? label.name_with_parent_names),
    color: stringValue(label.color) || null,
  }));
  const collaborators = [
    ...itemArray(conversation.users),
    ...itemArray(conversation.assignees),
  ].map((user) => ({
    id: stringValue(user.id ?? user.user_id),
    name: stringValue(user.name) || null,
    email: stringValue(user.email ?? user.address) || null,
    kind: stringValue(user.type) || null,
  }));
  const threadValues = {
    mailboxId,
    provider: "missive",
    providerThreadId,
    subject: stringValue(conversation.subject ?? conversation.latest_message_subject),
    counterpart: stringValue(fromField.name) || stringValue(fromField.address) || "Unknown",
    counterpartEmail: stringValue(fromField.address).toLowerCase(),
    status: conversation.closed_at ? "archived" : conversation.snoozed_until ? "snoozed" : "open",
    snippet: stringValue(newest.preview) || htmlToText(stringValue(newest.body)).slice(0, 300),
    webUrl: stringValue(conversation.web_url) || null,
    firstMessageAt: epochDate(oldest.delivered_at ?? oldest.created_at),
    lastMessageAt: epochDate(
      conversation.last_activity_at ?? newest.delivered_at ?? newest.created_at,
    ),
    messageCount: messages.length || numberValue(conversation.messages_count) || 0,
    participants: Array.from(
      new Set(
        messages.flatMap((message) => [
          ...addressList(message.from_field ? [message.from_field] : []),
          ...addressList(message.to_fields),
          ...addressList(message.cc_fields),
        ]),
      ),
    ),
    labels,
    inboxes: itemArray(conversation.team_inboxes ?? conversation.inboxes).map((inbox) => ({
      id: stringValue(inbox.id),
      name: stringValue(inbox.name),
    })),
    collaborators,
    hydrationState: "complete",
    hydrationError: null,
    hydratedAt: new Date(),
    sourceUpdatedAt: epochDate(conversation.last_activity_at),
    rawMetadata: safeMetadata(conversation),
    updatedAt: new Date(),
  };

  const [thread] = await db
    .insert(correspondenceThreadsTable)
    .values(threadValues)
    .onConflictDoUpdate({
      target: [
        correspondenceThreadsTable.provider,
        correspondenceThreadsTable.providerThreadId,
      ],
      set: threadValues,
    })
    .returning();

  for (const message of messages) await upsertMessage(thread.id, mailboxId, message);

  for (const comment of comments) {
    const providerCommentId = stringValue(comment.id);
    if (!providerCommentId) continue;
    const author =
      typeof comment.author === "object" && comment.author !== null
        ? (comment.author as Json)
        : typeof comment.user === "object" && comment.user !== null
          ? (comment.user as Json)
          : {};
    const createdAt = epochDate(comment.created_at);
    await db
      .insert(correspondenceCommentsTable)
      .values({
        threadId: thread.id,
        providerCommentId,
        authorProviderId: stringValue(author.id) || null,
        authorName: stringValue(author.name) || null,
        authorEmail: stringValue(author.email ?? author.address).toLowerCase() || null,
        bodyText: stripHtml(stringValue(comment.body ?? comment.text)),
        mentionedProviderUserIds: extractMentionIds(comment),
        createdAt,
        updatedAt: epochDate(comment.updated_at, createdAt),
      })
      .onConflictDoUpdate({
        target: correspondenceCommentsTable.providerCommentId,
        set: {
          bodyText: stripHtml(stringValue(comment.body ?? comment.text)),
          mentionedProviderUserIds: extractMentionIds(comment),
          updatedAt: epochDate(comment.updated_at, createdAt),
        },
      });
  }

  const providerIds = new Set(extractUserIds(conversation));
  for (const comment of comments) {
    for (const providerId of extractMentionIds(comment)) providerIds.add(providerId);
  }
  await db
    .update(correspondenceThreadGrantsTable)
    .set({ active: false, revokedAt: new Date() })
    .where(
      and(
        eq(correspondenceThreadGrantsTable.threadId, thread.id),
        eq(correspondenceThreadGrantsTable.source, "missive"),
      ),
    );
  for (const providerId of providerIds) {
    const staffId = staffByProviderId.get(providerId);
    if (!staffId) continue;
    await db
      .insert(correspondenceThreadGrantsTable)
      .values({
        threadId: thread.id,
        staffId,
        source: "missive",
        providerUserId: providerId,
        capabilities: ["read", "search", "cite"],
        active: true,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [
          correspondenceThreadGrantsTable.threadId,
          correspondenceThreadGrantsTable.staffId,
          correspondenceThreadGrantsTable.source,
        ],
        set: {
          providerUserId: providerId,
          capabilities: ["read", "search", "cite"],
          active: true,
          revokedAt: null,
          grantedAt: new Date(),
        },
      });
  }
  return true;
}

async function conversationIsCurrent(conversation: Json): Promise<boolean> {
  const providerThreadId = stringValue(conversation.id);
  const sourceUpdatedAt = numberValue(conversation.last_activity_at);
  if (!providerThreadId || sourceUpdatedAt == null) return false;
  const [existing] = await db
    .select({
      hydrationState: correspondenceThreadsTable.hydrationState,
      sourceUpdatedAt: correspondenceThreadsTable.sourceUpdatedAt,
    })
    .from(correspondenceThreadsTable)
    .where(
      and(
        eq(correspondenceThreadsTable.provider, "missive"),
        eq(correspondenceThreadsTable.providerThreadId, providerThreadId),
      ),
    )
    .limit(1);
  return (
    existing?.hydrationState === "complete" &&
    existing.sourceUpdatedAt != null &&
    existing.sourceUpdatedAt.getTime() >= epochDate(sourceUpdatedAt).getTime()
  );
}

async function ensureState() {
  await db
    .insert(correspondenceSyncStateTable)
    .values({ id: 1 })
    .onConflictDoNothing();
  return (await db.select().from(correspondenceSyncStateTable).where(eq(correspondenceSyncStateTable.id, 1)))[0]!;
}

export async function runMissiveSync(
  log: Logger,
  options: { fullHistoryForEmails?: string[]; fromDate?: string; toDate?: string } = {},
): Promise<{ ran: boolean; conversations: number; message: string }> {
  if (active) return { ran: false, conversations: 0, message: "Missive sync already running" };
  if (!isMissiveConnectorReady()) {
    return {
      ran: false,
      conversations: 0,
      message: "Missive API transport is temporarily unavailable",
    };
  }
  active = true;
  const state = await ensureState();
  await db
    .update(correspondenceSyncStateTable)
    .set({ syncActive: true, updatedAt: new Date() })
    .where(eq(correspondenceSyncStateTable.id, 1));
  try {
    // One token per team member: each Missive token only sees its own
    // account's conversations, so every configured account is synced in turn.
    // Conversations visible to several accounts dedupe naturally via the
    // (provider, provider_thread_id) upsert and the conversationIsCurrent
    // short-circuit.
    const accounts = missiveAccounts();
    const requestedFrom = options.fromDate ? new Date(options.fromDate).getTime() : Number.NaN;
    const requestedTo = options.toDate ? new Date(options.toDate).getTime() : Number.NaN;
    const cutoff = Number.isFinite(requestedFrom)
      ? requestedFrom
      : Date.now() - state.initialBackfillDays * 86_400_000;
    const staffByProviderId = new Map<string, string>();
    const accountSummaries: string[] = [];
    const accountErrors: string[] = [];
    let hydrated = 0;
    // Phase 1 — directory discovery across ALL usable accounts first, so a
    // user→staff mapping only visible through a later account still applies
    // to conversations hydrated under an earlier one (thread grants are
    // computed at hydration time and hydrated threads are skipped later).
    const usableAccounts: typeof accounts = [];
    for (const account of accounts) {
      try {
        mergeDirectories(staffByProviderId, await syncDirectory(account.token));
        usableAccounts.push(account);
      } catch (error) {
        // A bad/revoked token for one person must not block the others.
        const message =
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        if (/connector returned HTML|non-JSON response/i.test(message)) {
          connectorBlockedUntil = Date.now() + 60 * 60 * 1000;
        }
        log.error({ err: error, account: account.label }, "Missive directory sync failed for account");
        accountErrors.push(`${account.label}: ${message}`);
      }
    }
    // Phase 2 — conversation hydration per usable account.
    for (const account of usableAccounts) {
      try {
        let accountHydrated = 0;
        let until: number | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const payload = await missiveGet<Json>(
            missivePath("/v1/conversations", {
              // "all" covers inbox + archived (closed) + sent-only
              // conversations; trash and junk stay excluded. Inbox-only
              // listing silently missed teammates' archived history.
              all: "true",
              limit: CONVERSATION_LIMIT,
              until,
            }),
            account.token,
          );
          const conversations = itemArray(payload.conversations);
          for (const conversation of conversations) {
            const activityAt = epochDate(conversation.last_activity_at).getTime();
            const requestedEmails = options.fullHistoryForEmails ?? [];
            const searchable = JSON.stringify(safeMetadata(conversation)).toLowerCase();
            const requested = requestedEmails.some((email) =>
              searchable.includes(email.toLowerCase()),
            );
            if (activityAt < cutoff && !requested) continue;
            if (!options.fullHistoryForEmails?.length && await conversationIsCurrent(conversation)) {
              continue;
            }
            if (
              await hydrateConversation(
                conversation,
                staffByProviderId,
                options.fullHistoryForEmails?.length
                  ? {
                      from: Number.isFinite(requestedFrom) ? requestedFrom : undefined,
                      to: Number.isFinite(requestedTo) ? requestedTo : undefined,
                    }
                  : undefined,
                account.token,
              )
            ) accountHydrated++;
          }
          if (conversations.length < CONVERSATION_LIMIT || conversations.length === 0) break;
          const oldest = numberValue(conversations[conversations.length - 1]?.last_activity_at);
          if (oldest == null || oldest === until) break;
          if (
            oldest * 1000 < cutoff &&
            (Number.isFinite(requestedFrom) || !options.fullHistoryForEmails?.length)
          ) break;
          until = oldest;
        }
        hydrated += accountHydrated;
        accountSummaries.push(`${account.label}: ${accountHydrated}`);
      } catch (error) {
        // A bad/revoked token for one person must not block the others.
        const message =
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        if (/connector returned HTML|non-JSON response/i.test(message)) {
          connectorBlockedUntil = Date.now() + 60 * 60 * 1000;
        }
        log.error({ err: error, account: account.label }, "Missive sync failed for account");
        accountErrors.push(`${account.label}: ${message}`);
      }
    }
    if (accountErrors.length === accounts.length) {
      throw new Error(`All Missive accounts failed — ${accountErrors.join("; ")}`);
    }
    await purgeCorrespondenceRetention();
    const summary =
      `Hydrated ${hydrated} Missive conversation(s)` +
      (accounts.length > 1 ? ` (${accountSummaries.join(", ")})` : "") +
      (accountErrors.length ? `; failed accounts — ${accountErrors.join("; ")}` : "");
    await db
      .update(correspondenceSyncStateTable)
      .set({
        syncActive: false,
        lastSyncAt: new Date(),
        lastSyncStatus: accountErrors.length ? "partial" : "ok",
        lastSyncError: accountErrors.length ? accountErrors.join("; ").slice(0, 2000) : null,
        updatedAt: new Date(),
      })
      .where(eq(correspondenceSyncStateTable.id, 1));
    return { ran: true, conversations: hydrated, message: summary };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
    if (/connector returned HTML|non-JSON response/i.test(message)) {
      connectorBlockedUntil = Date.now() + 60 * 60 * 1000;
    }
    log.error({ err: error }, "Missive correspondence sync failed");
    await db
      .update(correspondenceSyncStateTable)
      .set({
        syncActive: false,
        lastSyncAt: new Date(),
        lastSyncStatus: "error",
        lastSyncError: message,
        updatedAt: new Date(),
      })
      .where(eq(correspondenceSyncStateTable.id, 1));
    return { ran: false, conversations: 0, message };
  } finally {
    active = false;
  }
}