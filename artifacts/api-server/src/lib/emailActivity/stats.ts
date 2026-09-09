import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Email activity aggregates — all computed in SQL over email_messages.
 * "Counted" mail is excluded_reason IS NULL; everything else is the
 * "filtered" bucket (visible, never silently dropped).
 *
 * All bucketing/heatmap math happens in America/Chicago — the shop's
 * timezone — so "9 AM" means 9 AM at the shop.
 */

const TZ = "America/Chicago";

export interface StatsRange {
  start: Date;
  end: Date;
  mailboxIds: string[];
}

function mailboxFilter(mailboxIds: string[]) {
  if (mailboxIds.length === 0) return sql`AND false`;
  return sql`AND m.mailbox_id IN (${sql.join(mailboxIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

type Rows<T> = { rows: T[] };

export async function overviewStats(range: StatsRange, granularity: "daily" | "weekly" | "monthly") {
  const trunc = granularity === "daily" ? "day" : granularity === "weekly" ? "week" : "month";
  const base = sql`
    m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
    ${mailboxFilter(range.mailboxIds)}
  `;
  const perMailbox = (
    (await db.execute(sql`
      SELECT m.mailbox_id,
        count(*) FILTER (WHERE m.excluded_reason IS NULL AND m.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE m.excluded_reason IS NULL AND m.direction = 'inbound')::int AS received,
        count(DISTINCT m.gmail_thread_id) FILTER (WHERE m.excluded_reason IS NULL)::int AS threads,
        count(*) FILTER (WHERE m.excluded_reason IS NOT NULL)::int AS filtered
      FROM email_messages m
      WHERE ${base}
      GROUP BY m.mailbox_id
    `)) as unknown as Rows<{ mailbox_id: string; sent: number; received: number; threads: number; filtered: number }>
  ).rows;

  const series = (
    (await db.execute(sql`
      SELECT m.mailbox_id,
        to_char(date_trunc(${trunc}, m.internal_date AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS bucket,
        count(*) FILTER (WHERE m.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE m.direction = 'inbound')::int AS received
      FROM email_messages m
      WHERE ${base} AND m.excluded_reason IS NULL
      GROUP BY 1, 2
      ORDER BY 2
    `)) as unknown as Rows<{ mailbox_id: string; bucket: string; sent: number; received: number }>
  ).rows;

  // Thread depth over counted messages: per (mailbox, thread) message count.
  const depth = (
    (await db.execute(sql`
      WITH t AS (
        SELECT m.mailbox_id, m.gmail_thread_id, count(*)::int AS depth
        FROM email_messages m
        WHERE ${base} AND m.excluded_reason IS NULL
        GROUP BY 1, 2
      )
      SELECT mailbox_id,
        round(avg(depth), 2)::float AS avg_depth,
        count(*) FILTER (WHERE depth = 1)::int AS d1,
        count(*) FILTER (WHERE depth BETWEEN 2 AND 3)::int AS d2_3,
        count(*) FILTER (WHERE depth BETWEEN 4 AND 6)::int AS d4_6,
        count(*) FILTER (WHERE depth >= 7)::int AS d7_plus
      FROM t GROUP BY 1
    `)) as unknown as Rows<{ mailbox_id: string; avg_depth: number; d1: number; d2_3: number; d4_6: number; d7_plus: number }>
  ).rows;

  return { perMailbox, series, depth };
}

/**
 * Response time per (mailbox, thread): first counted inbound message →
 * first counted outbound message after it. Threads with no inbound (pure
 * outreach) or no reply are excluded from the timing metrics.
 */
/**
 * Per-mailbox response-time rows PLUS one pooled row (mailbox_id = null)
 * computed over the same filtered thread population via GROUPING SETS, so the
 * team median/p90 is a true pooled percentile and honors any mailbox filter.
 */
export async function responseTimeStats(range: StatsRange) {
  const rows = (
    (await db.execute(sql`
      WITH firsts AS (
        SELECT m.mailbox_id, m.gmail_thread_id,
          min(m.internal_date) FILTER (WHERE m.direction = 'inbound') AS first_in
        FROM email_messages m
        WHERE m.excluded_reason IS NULL
          AND m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
          ${mailboxFilter(range.mailboxIds)}
        GROUP BY 1, 2
      ),
      replies AS (
        SELECT f.mailbox_id, f.gmail_thread_id, f.first_in,
          (SELECT min(o.internal_date) FROM email_messages o
            WHERE o.mailbox_id = f.mailbox_id AND o.gmail_thread_id = f.gmail_thread_id
              AND o.direction = 'outbound' AND o.excluded_reason IS NULL
              AND o.internal_date > f.first_in) AS first_reply
        FROM firsts f
        WHERE f.first_in IS NOT NULL
      ),
      timed AS (
        SELECT mailbox_id, EXTRACT(EPOCH FROM (first_reply - first_in))::float AS secs
        FROM replies WHERE first_reply IS NOT NULL
      )
      SELECT mailbox_id,
        count(*)::int AS replied_threads,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)::float AS median_secs,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY secs)::float AS p90_secs,
        count(*) FILTER (WHERE secs < 900)::int AS b_lt15m,
        count(*) FILTER (WHERE secs >= 900 AND secs < 3600)::int AS b_15m_1h,
        count(*) FILTER (WHERE secs >= 3600 AND secs < 14400)::int AS b_1h_4h,
        count(*) FILTER (WHERE secs >= 14400 AND secs < 86400)::int AS b_4h_24h,
        count(*) FILTER (WHERE secs >= 86400)::int AS b_gt24h
      FROM timed GROUP BY GROUPING SETS ((mailbox_id), ())
    `)) as unknown as Rows<{
      mailbox_id: string | null;
      replied_threads: number;
      median_secs: number;
      p90_secs: number;
      b_lt15m: number;
      b_15m_1h: number;
      b_1h_4h: number;
      b_4h_24h: number;
      b_gt24h: number;
    }>
  ).rows;
  return rows;
}

/** Threads whose latest counted message is inbound and older than the threshold. */
export async function unansweredThreads(thresholdHours: number, mailboxIds: string[], limit = 100) {
  const rows = (
    (await db.execute(sql`
      WITH last_msg AS (
        SELECT DISTINCT ON (m.mailbox_id, m.gmail_thread_id)
          m.id, m.mailbox_id, m.gmail_thread_id, m.direction, m.internal_date,
          m.subject, m.counterpart_address,
          count(*) OVER (PARTITION BY m.mailbox_id, m.gmail_thread_id)::int AS msg_count
        FROM email_messages m
        WHERE m.excluded_reason IS NULL
          AND m.internal_date >= now() - interval '90 days'
          ${mailboxFilter(mailboxIds)}
        ORDER BY m.mailbox_id, m.gmail_thread_id, m.internal_date DESC
      )
      SELECT id, mailbox_id, gmail_thread_id, subject, counterpart_address,
        internal_date AS last_inbound_at, msg_count,
        EXTRACT(EPOCH FROM (now() - internal_date))::float / 3600 AS age_hours
      FROM last_msg
      WHERE direction = 'inbound'
        AND internal_date < now() - make_interval(hours => ${thresholdHours})
      ORDER BY internal_date ASC
      LIMIT ${limit}
    `)) as unknown as Rows<{
      id: string;
      mailbox_id: string;
      gmail_thread_id: string;
      subject: string;
      counterpart_address: string;
      last_inbound_at: string | Date;
      msg_count: number;
      age_hours: number;
    }>
  ).rows;
  return rows;
}

/** 7×24 heatmap in shop-local time. dow: 0=Sunday .. 6=Saturday. */
export async function heatmapStats(range: StatsRange) {
  const rows = (
    (await db.execute(sql`
      SELECT
        EXTRACT(DOW FROM m.internal_date AT TIME ZONE ${TZ})::int AS dow,
        EXTRACT(HOUR FROM m.internal_date AT TIME ZONE ${TZ})::int AS hour,
        count(*) FILTER (WHERE m.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE m.direction = 'inbound')::int AS received
      FROM email_messages m
      WHERE m.excluded_reason IS NULL
        AND m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
        ${mailboxFilter(range.mailboxIds)}
      GROUP BY 1, 2
    `)) as unknown as Rows<{ dow: number; hour: number; sent: number; received: number }>
  ).rows;
  return rows;
}

/** Most recent counted threads in each direction, with full-thread direction counts. */
export async function recentMessages(range: StatsRange, limitPerDirection = 50) {
  const rows = (
    (await db.execute(sql`
      WITH range_messages AS (
        SELECT m.id, m.mailbox_id, m.gmail_thread_id, m.subject,
          m.counterpart_address, m.direction, m.internal_date,
          row_number() OVER (
            PARTITION BY m.mailbox_id, m.gmail_thread_id, m.direction
            ORDER BY m.internal_date DESC
          ) AS thread_direction_rank
        FROM email_messages m
        WHERE m.excluded_reason IS NULL
          AND m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
          ${mailboxFilter(range.mailboxIds)}
      ),
      direction_latest AS (
        SELECT *,
          row_number() OVER (PARTITION BY direction ORDER BY internal_date DESC) AS direction_rank
        FROM range_messages
        WHERE thread_direction_rank = 1
      ),
      candidates AS (
        SELECT *
        FROM direction_latest
        WHERE direction_rank <= ${limitPerDirection}
      )
      SELECT c.id, c.mailbox_id, c.gmail_thread_id, c.subject, c.counterpart_address,
        c.direction, c.internal_date,
        count(*) FILTER (WHERE t.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE t.direction = 'inbound')::int AS received
      FROM candidates c
      JOIN email_messages t
        ON t.mailbox_id = c.mailbox_id
       AND t.gmail_thread_id = c.gmail_thread_id
       AND t.excluded_reason IS NULL
      GROUP BY c.id, c.mailbox_id, c.gmail_thread_id, c.subject,
        c.counterpart_address, c.direction, c.internal_date, c.direction_rank
      ORDER BY c.direction, c.direction_rank
    `)) as unknown as Rows<{
      id: string;
      mailbox_id: string;
      gmail_thread_id: string;
      subject: string;
      counterpart_address: string;
      direction: "inbound" | "outbound";
      internal_date: string | Date;
      sent: number;
      received: number;
    }>
  ).rows;
  return rows;
}

/** Filtered-bucket breakdown + a recent sample for spot-checking. */
export async function filteredStats(range: StatsRange, sampleLimit = 50) {
  const breakdown = (
    (await db.execute(sql`
      SELECT m.excluded_reason AS reason, count(*)::int AS count
      FROM email_messages m
      WHERE m.excluded_reason IS NOT NULL
        AND m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
        ${mailboxFilter(range.mailboxIds)}
      GROUP BY 1 ORDER BY 2 DESC
    `)) as unknown as Rows<{ reason: string; count: number }>
  ).rows;
  const sample = (
    (await db.execute(sql`
      SELECT m.id, m.mailbox_id, m.gmail_thread_id, m.subject, m.counterpart_address,
        m.excluded_reason, m.direction, m.internal_date
      FROM email_messages m
      WHERE m.excluded_reason IS NOT NULL
        AND m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
        ${mailboxFilter(range.mailboxIds)}
      ORDER BY m.internal_date DESC
      LIMIT ${sampleLimit}
    `)) as unknown as Rows<{
      id: string;
      mailbox_id: string;
      gmail_thread_id: string;
      subject: string;
      counterpart_address: string;
      excluded_reason: string;
      direction: string;
      internal_date: string | Date;
    }>
  ).rows;
  return { breakdown, sample };
}
