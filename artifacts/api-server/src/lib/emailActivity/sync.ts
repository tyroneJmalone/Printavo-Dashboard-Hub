import { db, emailMailboxesTable, emailMessagesTable, emailActivitySettingsTable, type EmailMailbox } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { GmailMailboxClient, GmailApiError, gmailConfigured } from "./gmail";
import { parseGmailMessage, classifyMessages } from "./classify";

/**
 * Per-mailbox Gmail metadata sync.
 *
 * First run: resumable backfill through messages.list (q: newer_than:Nd),
 * with the profile historyId snapshotted BEFORE the backfill starts so the
 * incremental path later catches anything that arrived mid-backfill.
 * After backfill: incremental history.list from lastHistoryId. An expired
 * historyId (404) falls back to a fresh 7-day catch-up window plus a new
 * watermark — dedup happens on the (mailbox, gmail_id) unique index either
 * way.
 */

const FETCH_CONCURRENCY = 6;
/** Cap per tick so one giant backfill doesn't hog a tick forever. */
const MAX_PAGES_PER_TICK = 20;

let syncActive = false;
export function isEmailSyncActive(): boolean {
  return syncActive;
}

export async function getEmailSettings() {
  const [row] = await db.select().from(emailActivitySettingsTable).limit(1);
  if (row) return row;
  const [created] = await db
    .insert(emailActivitySettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  return created ?? (await db.select().from(emailActivitySettingsTable).limit(1))[0]!;
}

async function fetchAndStore(
  client: GmailMailboxClient,
  mailbox: EmailMailbox,
  ids: { id: string }[],
  log: Logger,
): Promise<number> {
  let stored = 0;
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const batch = ids.slice(i, i + FETCH_CONCURRENCY);
    const metas = await Promise.all(
      batch.map(async ({ id }) => {
        try {
          return await client.getMessageMetadata(id);
        } catch (err) {
          // A message deleted between list and get is normal; skip it.
          if (err instanceof GmailApiError && err.status === 404) return null;
          throw err;
        }
      }),
    );
    const rows = metas
      .map((m) => (m ? parseGmailMessage(m, mailbox.email) : null))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => ({
        mailboxId: mailbox.id,
        gmailId: p.gmailId,
        gmailThreadId: p.gmailThreadId,
        direction: p.direction,
        fromAddress: p.fromAddress,
        toAddresses: p.toAddresses,
        counterpartAddress: p.counterpartAddress,
        counterpartDomain: p.counterpartDomain,
        subject: p.subject,
        internalDate: p.internalDate,
        sizeEstimate: p.sizeEstimate,
        labelIds: p.labelIds,
        hasListUnsubscribe: p.hasListUnsubscribe,
        isAutoSubmitted: p.isAutoSubmitted,
      }));
    if (rows.length === 0) continue;
    const inserted = await db
      .insert(emailMessagesTable)
      .values(rows)
      .onConflictDoNothing({ target: [emailMessagesTable.mailboxId, emailMessagesTable.gmailId] })
      .returning({ id: emailMessagesTable.id });
    stored += inserted.length;
    await classifyMessages(inserted.map((r) => r.id));
  }
  if (stored > 0) log.debug({ mailbox: mailbox.email, stored }, "email messages stored");
  return stored;
}

async function runBackfill(client: GmailMailboxClient, mailbox: EmailMailbox, log: Logger): Promise<void> {
  const settings = await getEmailSettings();
  let pageToken = mailbox.backfillPageToken ?? undefined;
  if (!mailbox.backfillStartedAt) {
    // Snapshot the watermark FIRST so nothing that arrives during backfill
    // slips between backfill and the first incremental run.
    const profile = await client.getProfile();
    await db
      .update(emailMailboxesTable)
      .set({ lastHistoryId: profile.historyId, backfillStartedAt: new Date() })
      .where(eq(emailMailboxesTable.id, mailbox.id));
  }
  const q = `newer_than:${settings.backfillDays}d`;
  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const list = await client.listMessages({ q, pageToken });
    await fetchAndStore(client, mailbox, list.messages ?? [], log);
    pageToken = list.nextPageToken;
    await db
      .update(emailMailboxesTable)
      .set({ backfillPageToken: pageToken ?? null, ...(pageToken ? {} : { backfillCompletedAt: new Date() }) })
      .where(eq(emailMailboxesTable.id, mailbox.id));
    if (!pageToken) {
      log.info({ mailbox: mailbox.email }, "email backfill complete");
      return;
    }
  }
  log.info({ mailbox: mailbox.email }, "email backfill page cap hit — resuming next tick");
}

async function runIncremental(client: GmailMailboxClient, mailbox: EmailMailbox, log: Logger): Promise<void> {
  let startHistoryId = mailbox.lastHistoryId;
  if (!startHistoryId) {
    const profile = await client.getProfile();
    await db
      .update(emailMailboxesTable)
      .set({ lastHistoryId: profile.historyId })
      .where(eq(emailMailboxesTable.id, mailbox.id));
    return;
  }
  try {
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;
    const ids: { id: string }[] = [];
    do {
      const res = await client.listHistory({ startHistoryId, pageToken });
      for (const h of res.history ?? []) {
        for (const added of h.messagesAdded ?? []) ids.push({ id: added.message.id });
      }
      if (res.historyId) latestHistoryId = res.historyId;
      pageToken = res.nextPageToken;
    } while (pageToken);
    await fetchAndStore(client, mailbox, ids, log);
    await db
      .update(emailMailboxesTable)
      .set({ lastHistoryId: latestHistoryId })
      .where(eq(emailMailboxesTable.id, mailbox.id));
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 404) {
      // historyId expired — catch up on a recent window and rebase the watermark.
      log.warn({ mailbox: mailbox.email }, "gmail historyId expired — 7-day catch-up");
      const profile = await client.getProfile();
      let pageToken: string | undefined;
      do {
        const list = await client.listMessages({ q: "newer_than:7d", pageToken });
        await fetchAndStore(client, mailbox, list.messages ?? [], log);
        pageToken = list.nextPageToken;
      } while (pageToken);
      await db
        .update(emailMailboxesTable)
        .set({ lastHistoryId: profile.historyId })
        .where(eq(emailMailboxesTable.id, mailbox.id));
    } else {
      throw err;
    }
  }
}

export async function syncMailbox(mailbox: EmailMailbox, log: Logger): Promise<void> {
  const client = new GmailMailboxClient(mailbox.email);
  try {
    if (!mailbox.backfillCompletedAt) {
      await runBackfill(client, mailbox, log);
    } else {
      await runIncremental(client, mailbox, log);
    }
    await db
      .update(emailMailboxesTable)
      .set({ lastSyncAt: new Date(), lastSyncStatus: "ok", lastSyncError: null })
      .where(eq(emailMailboxesTable.id, mailbox.id));
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000);
    log.error({ err, mailbox: mailbox.email }, "email mailbox sync failed");
    await db
      .update(emailMailboxesTable)
      .set({ lastSyncAt: new Date(), lastSyncStatus: "error", lastSyncError: message })
      .where(eq(emailMailboxesTable.id, mailbox.id));
  }
}

/** Sync all active mailboxes sequentially. One failure never blocks the rest. */
export async function runEmailSync(log: Logger): Promise<{ ran: boolean; message: string }> {
  if (!gmailConfigured()) return { ran: false, message: "GOOGLE_SERVICE_ACCOUNT_JSON is not configured" };
  if (syncActive) return { ran: false, message: "Email sync already running" };
  syncActive = true;
  try {
    const mailboxes = await db
      .select()
      .from(emailMailboxesTable)
      .where(eq(emailMailboxesTable.active, true))
      .orderBy(emailMailboxesTable.createdAt);
    if (mailboxes.length === 0) return { ran: false, message: "No active mailboxes configured" };
    for (const mailbox of mailboxes) {
      await syncMailbox(mailbox, log);
    }
    return { ran: true, message: `Synced ${mailboxes.length} mailbox(es)` };
  } finally {
    syncActive = false;
  }
}

/** Health probe used by the setup screen's "Verify" button. */
export async function verifyMailbox(email: string): Promise<{ ok: boolean; error: string | null; messagesTotal: number | null }> {
  if (!gmailConfigured()) {
    return { ok: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON secret is not configured", messagesTotal: null };
  }
  try {
    const client = new GmailMailboxClient(email);
    const profile = await client.getProfile();
    return { ok: true, error: null, messagesTotal: profile.messagesTotal };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    if (/unauthorized_client/i.test(message)) {
      message =
        "unauthorized_client — domain-wide delegation is not granted for this service account (check the Client ID and the gmail.readonly scope in the Google Admin console)";
    } else if (/invalid_grant/i.test(message)) {
      message = `invalid_grant — "${email}" is probably not a real mailbox in your Google Workspace domain`;
    }
    return { ok: false, error: message.slice(0, 1000), messagesTotal: null };
  }
}

export async function messageCounts(): Promise<Map<string, { total: number; filtered: number }>> {
  const rows = (
    (await db.execute(sql`
      SELECT mailbox_id, count(*)::int AS total,
             count(*) FILTER (WHERE excluded_reason IS NOT NULL)::int AS filtered
      FROM email_messages GROUP BY mailbox_id
    `)) as unknown as { rows: { mailbox_id: string; total: number; filtered: number }[] }
  ).rows;
  return new Map(rows.map((r) => [r.mailbox_id, { total: Number(r.total), filtered: Number(r.filtered) }]));
}
