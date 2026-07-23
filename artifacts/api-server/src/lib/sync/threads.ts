import type { Logger } from "pino";
import { db, pvThreadsTable, pvMessagesTable } from "@workspace/db";
import { asc, eq, sql } from "drizzle-orm";
import {
  threadsPageQuery,
  threadMessagesPageQuery,
  PAGE_SIZE,
  type Connection,
} from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { contentHashOf, dateOrNull, normalizeTimestamps } from "./differ";

interface ThreadSummaryNode {
  id: string;
  unread?: boolean | null;
  regarding?: {
    __typename?: string;
    id?: string;
    visualId?: number | null;
  } | null;
  lastReceivedMessage?: { id?: string | null } | null;
  [key: string]: unknown;
}

interface MessageNode {
  __typename: string;
  id: string;
  timestamps?: { createdAt?: string | null } | null;
  [key: string]: unknown;
}

interface ThreadMessagesResponse {
  thread: { id: string; messages: Connection<MessageNode> } | null;
}

export interface ThreadsAgg {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  flaggedStale: number;
  pages: number;
  earlyStopped: boolean;
}

export interface ThreadsEarlyStop {
  floorPages: number;
  stopAfterUnchangedPages: number;
}

/**
 * Backup module (B4d): crawl the threads list (thread SUMMARIES —
 * the API exposes no full messages at the list level). The list is
 * ordered by lastReceivedMessage recency (verified live July 2026),
 * so with `earlyStop` the crawl may stop once BOTH (a) `floorPages`
 * pages are covered and (b) the last K pages contained zero
 * message-relevant changes (new thread OR lastReceivedMessage.id
 * moved). Pass null for the daily full-depth crawl.
 *
 * A thread whose lastReceivedMessage.id changed is flagged
 * messages_stale for the drip. LIMITATION: lastReceivedMessage tracks
 * INCOMING messages only — outgoing-only activity is caught by the
 * weekly deep re-flag (threads_deep watermark in the poll).
 */
export async function crawlThreadSummaries(
  earlyStop: ThreadsEarlyStop | null,
  logger: Logger,
): Promise<ThreadsAgg> {
  const client = getPrintavoClient();
  const agg: ThreadsAgg = {
    seen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    flaggedStale: 0,
    pages: 0,
    earlyStopped: false,
  };

  let cursor: string | null = null;
  let consecutiveUnchangedPages = 0;
  for (;;) {
    const data: { threads: Connection<ThreadSummaryNode> } =
      await client.query<{ threads: Connection<ThreadSummaryNode> }>(
        threadsPageQuery(cursor),
      );
    let pageHadMessageChange = false;
    for (const rawNode of data.threads.nodes) {
      const node = normalizeTimestamps(rawNode);
      const hash = contentHashOf(node);
      const lastMessageId = node.lastReceivedMessage?.id ?? null;
      agg.seen += 1;

      const [existing] = await db
        .select({
          contentHash: pvThreadsTable.contentHash,
          lastMessageId: pvThreadsTable.lastMessageId,
        })
        .from(pvThreadsTable)
        .where(eq(pvThreadsTable.printavoId, node.id))
        .limit(1);

      if (!existing) {
        await db.insert(pvThreadsTable).values({
          printavoId: node.id,
          orderPrintavoId: node.regarding?.id ?? null,
          orderVisualId: node.regarding?.visualId ?? null,
          unread: node.unread ?? null,
          lastMessageId,
          // messagesStale defaults true — free backfill via the drip
          data: node,
          contentHash: hash,
          syncedAt: new Date(),
        });
        agg.created += 1;
        agg.flaggedStale += 1;
        pageHadMessageChange = true;
        continue;
      }

      if (existing.contentHash === hash) {
        await db
          .update(pvThreadsTable)
          .set({ syncedAt: new Date() })
          .where(eq(pvThreadsTable.printavoId, node.id));
        agg.unchanged += 1;
        continue;
      }

      const messageMoved = lastMessageId !== existing.lastMessageId;
      await db
        .update(pvThreadsTable)
        .set({
          orderPrintavoId: node.regarding?.id ?? null,
          orderVisualId: node.regarding?.visualId ?? null,
          unread: node.unread ?? null,
          lastMessageId,
          ...(messageMoved ? { messagesStale: true } : {}),
          data: node,
          contentHash: hash,
          syncedAt: new Date(),
        })
        .where(eq(pvThreadsTable.printavoId, node.id));
      agg.updated += 1;
      if (messageMoved) {
        agg.flaggedStale += 1;
        pageHadMessageChange = true;
      }
    }
    agg.pages += 1;

    if (!data.threads.pageInfo.hasNextPage) break;
    if (earlyStop) {
      consecutiveUnchangedPages = pageHadMessageChange
        ? 0
        : consecutiveUnchangedPages + 1;
      if (
        agg.pages >= earlyStop.floorPages &&
        consecutiveUnchangedPages >= earlyStop.stopAfterUnchangedPages
      ) {
        agg.earlyStopped = true;
        break;
      }
    }
    cursor = data.threads.pageInfo.endCursor;
  }

  if (!earlyStop) {
    logger.info({ agg }, "Threads full summary crawl complete");
  }
  return agg;
}

export interface MessagesDripAgg {
  threads: number;
  messages: number;
  written: number;
  unchanged: number;
  failures: number;
}

/**
 * Backup module (B4d): drip-refresh full messages for up to `cap`
 * stale threads per scheduled poll (extras-drip pattern). Each thread
 * costs ≥1 throttled request (25 messages/page). messages_attempted_at
 * is stamped BEFORE the fetch so permanently-failing threads cycle to
 * the back instead of starving the queue.
 */
export async function runMessagesDrip(
  cap: number,
  logger: Logger,
): Promise<MessagesDripAgg> {
  const agg: MessagesDripAgg = {
    threads: 0,
    messages: 0,
    written: 0,
    unchanged: 0,
    failures: 0,
  };
  if (cap <= 0) return agg;

  const staleThreads = await db
    .select({ printavoId: pvThreadsTable.printavoId })
    .from(pvThreadsTable)
    .where(eq(pvThreadsTable.messagesStale, true))
    .orderBy(
      sql`${pvThreadsTable.messagesAttemptedAt} ASC NULLS FIRST`,
      asc(pvThreadsTable.printavoId),
    )
    .limit(cap);
  if (staleThreads.length === 0) return agg;

  const client = getPrintavoClient();
  for (const { printavoId } of staleThreads) {
    agg.threads += 1;
    await db
      .update(pvThreadsTable)
      .set({ messagesAttemptedAt: new Date() })
      .where(eq(pvThreadsTable.printavoId, printavoId));
    try {
      let cursor: string | null = null;
      for (;;) {
        const data: ThreadMessagesResponse =
          await client.query<ThreadMessagesResponse>(
            threadMessagesPageQuery(printavoId, cursor),
          );
        const messages = data.thread?.messages;
        if (!messages) {
          // Thread gone upstream — keep existing rows (backup
          // semantics), stop retrying.
          logger.warn({ threadId: printavoId }, "Thread vanished — unflagging");
          break;
        }
        for (const rawNode of messages.nodes) {
          const node = normalizeTimestamps(rawNode);
          const hash = contentHashOf(node);
          agg.messages += 1;

          const [existing] = await db
            .select({ contentHash: pvMessagesTable.contentHash })
            .from(pvMessagesTable)
            .where(eq(pvMessagesTable.printavoId, node.id))
            .limit(1);
          if (existing && existing.contentHash === hash) {
            agg.unchanged += 1;
            continue;
          }
          const row = {
            printavoId: node.id,
            threadPrintavoId: printavoId,
            typename: node.__typename,
            createdAt: dateOrNull(node.timestamps?.createdAt),
            data: node,
            contentHash: hash,
            syncedAt: new Date(),
          };
          await db
            .insert(pvMessagesTable)
            .values(row)
            .onConflictDoUpdate({
              target: pvMessagesTable.printavoId,
              set: {
                threadPrintavoId: row.threadPrintavoId,
                typename: row.typename,
                createdAt: row.createdAt,
                data: row.data,
                contentHash: row.contentHash,
                syncedAt: row.syncedAt,
              },
            });
          agg.written += 1;
        }
        if (!messages.pageInfo.hasNextPage) break;
        cursor = messages.pageInfo.endCursor;
      }
      await db
        .update(pvThreadsTable)
        .set({ messagesStale: false, messagesSyncedAt: new Date() })
        .where(eq(pvThreadsTable.printavoId, printavoId));
    } catch (err) {
      agg.failures += 1;
      logger.warn(
        { threadId: printavoId, err },
        "Messages drip failed for thread — will retry after other stale threads",
      );
    }
  }

  logger.info({ agg }, "Messages drip complete");
  return agg;
}

/** Weekly deep re-flag: marks recently-active threads messages_stale
 * so the drip re-pulls their messages — the safety net for outgoing
 * replies that lastReceivedMessage never surfaces. Scoped to threads
 * with an incoming message in the last `activeDays` days (Tyler,
 * 2026-07-22: 60 days — a full 8,467-thread rescan took ~14h and
 * pushed new-message pickup behind the backlog; 60-day scope covers
 * replies on any live conversation in well under an hour). Trade-off
 * accepted: a reply sent on a thread dormant >60 days is only captured
 * if the customer later writes back on it. Returns count. */
export async function reflagRecentThreadMessages(
  activeDays: number,
): Promise<number> {
  const rows = await db
    .update(pvThreadsTable)
    .set({ messagesStale: true })
    .where(
      sql`(${pvThreadsTable.data}->'lastReceivedMessage'->'timestamps'->>'createdAt')::timestamptz > now() - make_interval(days => ${activeDays})`,
    )
    .returning({ id: pvThreadsTable.printavoId });
  return rows.length;
}

/** Page-size export for poll budgeting docs/tests. */
export const THREADS_PAGE_SIZE = PAGE_SIZE;
