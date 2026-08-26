import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { notChipplySql } from "../chipply/matching";

/**
 * Email ↔ Printavo correlation.
 *
 * Customer matching: every participant address on a counted message
 * (from + to/cc) is compared against the synced customer emails —
 * pv_customers primaryContact email plus every pv_contacts row. Matches
 * insert into email_thread_customers with source='auto'. The pass is
 * idempotent (ON CONFLICT DO NOTHING), so it is both retroactive and
 * incremental: it runs after every Gmail sync over the whole table.
 *
 * Invoice matching: "#1234"-style tokens in subjects are validated
 * against pv_orders.visual_id. visual_id is NOT unique (quote→invoice
 * conversions, multi-year wraparound), so a candidate order must belong
 * to a customer already linked to the thread when such links exist;
 * among remaining candidates we prefer invoices, then the most recent.
 * Suppressed rows (manually unlinked auto matches) block re-insertion
 * via the same unique index.
 */

type Rows<T> = { rows: T[] };

export async function runCustomerMatching(): Promise<number> {
  const r = (await db.execute(sql`
    WITH cust_emails AS (
      SELECT lower(c.data->'primaryContact'->>'email') AS email, c.printavo_id AS customer_id
        FROM pv_customers c
       WHERE coalesce(c.data->'primaryContact'->>'email', '') <> ''
      UNION
      SELECT lower(ct.email), ct.customer_id
        FROM pv_contacts ct
       WHERE coalesce(ct.email, '') <> '' AND ct.customer_id IS NOT NULL
    ),
    participants AS (
      SELECT DISTINCT m.mailbox_id, m.gmail_thread_id, lower(p.addr) AS email
        FROM email_messages m
        CROSS JOIN LATERAL unnest(array_append(m.to_addresses, m.from_address)) AS p(addr)
       WHERE m.excluded_reason IS NULL AND coalesce(p.addr, '') <> ''
    )
    INSERT INTO email_thread_customers
      (mailbox_id, gmail_thread_id, printavo_customer_id, source, matched_email)
    SELECT p.mailbox_id, p.gmail_thread_id, ce.customer_id, 'auto', min(p.email)
      FROM participants p
      JOIN cust_emails ce ON ce.email = p.email
     GROUP BY p.mailbox_id, p.gmail_thread_id, ce.customer_id
    ON CONFLICT (mailbox_id, gmail_thread_id, printavo_customer_id) DO NOTHING
  `)) as unknown as { rowCount?: number };
  return r.rowCount ?? 0;
}

export async function runInvoiceMatching(): Promise<number> {
  const r = (await db.execute(sql`
    WITH cand AS (
      SELECT DISTINCT m.mailbox_id, m.gmail_thread_id, (rm.g)[1]::int AS visual_id
        FROM email_messages m
        CROSS JOIN LATERAL regexp_matches(m.subject, '#(\\d{3,7})', 'g') AS rm(g)
       WHERE m.excluded_reason IS NULL AND m.subject LIKE '%#%'
    ),
    matched AS (
      SELECT DISTINCT ON (c.mailbox_id, c.gmail_thread_id, c.visual_id)
             c.mailbox_id, c.gmail_thread_id, o.printavo_id, o.visual_id
        FROM cand c
        JOIN pv_orders o ON o.visual_id = c.visual_id
       WHERE (
           NOT EXISTS (SELECT 1 FROM email_thread_customers tc
                        WHERE tc.mailbox_id = c.mailbox_id
                          AND tc.gmail_thread_id = c.gmail_thread_id)
           OR EXISTS (SELECT 1 FROM email_thread_customers tc
                       WHERE tc.mailbox_id = c.mailbox_id
                         AND tc.gmail_thread_id = c.gmail_thread_id
                         AND tc.printavo_customer_id = o.customer_id)
         )
       ORDER BY c.mailbox_id, c.gmail_thread_id, c.visual_id,
                (o.order_type = 'invoice') DESC,
                o.invoice_at DESC NULLS LAST, o.printavo_id DESC
    )
    INSERT INTO email_thread_orders
      (mailbox_id, gmail_thread_id, printavo_order_id, visual_id, source)
    SELECT mailbox_id, gmail_thread_id, printavo_id, visual_id, 'auto'
      FROM matched
    ON CONFLICT (mailbox_id, gmail_thread_id, printavo_order_id) DO NOTHING
  `)) as unknown as { rowCount?: number };
  return r.rowCount ?? 0;
}

/** Run both passes; never throws (correlation must not break the sync). */
export async function runEmailMatching(
  log: Logger,
): Promise<{ customersLinked: number; invoicesLinked: number }> {
  try {
    const customersLinked = await runCustomerMatching();
    const invoicesLinked = await runInvoiceMatching();
    if (customersLinked > 0 || invoicesLinked > 0) {
      log.info({ customersLinked, invoicesLinked }, "email matching pass linked new threads");
    }
    return { customersLinked, invoicesLinked };
  } catch (err) {
    log.error({ err }, "email matching pass failed");
    return { customersLinked: 0, invoicesLinked: 0 };
  }
}

// ── Per-customer correspondence ──────────────────────────────────────

export interface CustomerThreadRow {
  mailbox_id: string;
  gmail_thread_id: string;
  subject: string;
  counterpart_address: string;
  msg_count: number;
  sent: number;
  received: number;
  first_at: string | Date;
  last_at: string | Date;
}

function customerThreadAcl(staffId: string, mailboxIds: string[]) {
  const mailboxAccess = mailboxIds.length
    ? sql`m.mailbox_id IN (${sql.join(mailboxIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql`false`;
  return sql`(
    ${mailboxAccess}
    OR EXISTS (
      SELECT 1
      FROM correspondence_threads ct
      JOIN correspondence_thread_grants tg ON tg.thread_id=ct.id
      WHERE ct.mailbox_id=m.mailbox_id
        AND ct.gmail_thread_id=m.gmail_thread_id
        AND tg.staff_id=${staffId}::uuid
        AND tg.active=true
        AND tg.revoked_at IS NULL
        AND (tg.expires_at IS NULL OR tg.expires_at > now())
        AND 'read'=ANY(tg.capabilities)
    )
  )`;
}

export async function customerThreads(
  customerId: string,
  staffId: string,
  mailboxIds: string[],
  limit = 25,
): Promise<CustomerThreadRow[]> {
  const access = customerThreadAcl(staffId, mailboxIds);
  return (
    (await db.execute(sql`
      SELECT m.mailbox_id, m.gmail_thread_id,
        (array_agg(m.subject ORDER BY m.internal_date DESC) FILTER (WHERE m.subject <> ''))[1] AS subject,
        (array_agg(m.counterpart_address ORDER BY m.internal_date DESC))[1] AS counterpart_address,
        count(*)::int AS msg_count,
        count(*) FILTER (WHERE m.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE m.direction = 'inbound')::int AS received,
        min(m.internal_date) AS first_at,
        max(m.internal_date) AS last_at
      FROM email_thread_customers tc
      JOIN email_messages m
        ON m.mailbox_id = tc.mailbox_id AND m.gmail_thread_id = tc.gmail_thread_id
      WHERE tc.printavo_customer_id = ${customerId}
        AND m.excluded_reason IS NULL
        AND ${access}
      GROUP BY m.mailbox_id, m.gmail_thread_id
      ORDER BY max(m.internal_date) DESC
      LIMIT ${limit}
    `)) as unknown as Rows<CustomerThreadRow>
  ).rows;
}

export interface CustomerEmailStatsRow {
  thread_count: number;
  message_count: number;
  sent: number;
  received: number;
  last_email_at: string | Date | null;
  replied_threads: number;
  median_secs: number | null;
  p90_secs: number | null;
}

export async function customerEmailStats(
  customerId: string,
  staffId: string,
  mailboxIds: string[],
): Promise<CustomerEmailStatsRow> {
  const access = customerThreadAcl(staffId, mailboxIds);
  const totals = (
    (await db.execute(sql`
      SELECT count(DISTINCT (m.mailbox_id, m.gmail_thread_id))::int AS thread_count,
        count(*)::int AS message_count,
        count(*) FILTER (WHERE m.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE m.direction = 'inbound')::int AS received,
        max(m.internal_date) AS last_email_at
      FROM email_thread_customers tc
      JOIN email_messages m
        ON m.mailbox_id = tc.mailbox_id AND m.gmail_thread_id = tc.gmail_thread_id
      WHERE tc.printavo_customer_id = ${customerId}
        AND m.excluded_reason IS NULL
        AND ${access}
    `)) as unknown as Rows<Omit<CustomerEmailStatsRow, "replied_threads" | "median_secs" | "p90_secs">>
  ).rows[0]!;
  const timing = (
    (await db.execute(sql`
      WITH firsts AS (
        SELECT m.mailbox_id, m.gmail_thread_id,
          min(m.internal_date) FILTER (WHERE m.direction = 'inbound') AS first_in
        FROM email_thread_customers tc
        JOIN email_messages m
          ON m.mailbox_id = tc.mailbox_id AND m.gmail_thread_id = tc.gmail_thread_id
        WHERE tc.printavo_customer_id = ${customerId}
          AND m.excluded_reason IS NULL
          AND ${access}
        GROUP BY 1, 2
      ),
      timed AS (
        SELECT EXTRACT(EPOCH FROM (
          (SELECT min(o.internal_date) FROM email_messages o
            WHERE o.mailbox_id = f.mailbox_id AND o.gmail_thread_id = f.gmail_thread_id
              AND o.direction = 'outbound' AND o.excluded_reason IS NULL
              AND o.internal_date > f.first_in) - f.first_in))::float AS secs
        FROM firsts f WHERE f.first_in IS NOT NULL
      )
      SELECT count(*) FILTER (WHERE secs IS NOT NULL)::int AS replied_threads,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)::float AS median_secs,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY secs)::float AS p90_secs
      FROM timed
    `)) as unknown as Rows<Pick<CustomerEmailStatsRow, "replied_threads" | "median_secs" | "p90_secs">>
  ).rows[0]!;
  return { ...totals, ...timing };
}

export interface ThreadOrderLinkRow {
  id: string;
  mailbox_id: string;
  gmail_thread_id: string;
  printavo_order_id: string;
  visual_id: number | null;
  source: string;
  nickname: string | null;
  order_type: string | null;
  status_name: string | null;
  total: string | null;
}

/** Active (non-suppressed) invoice links for a set of threads, order info joined. */
export async function threadOrderLinks(
  threads: { mailboxId: string; gmailThreadId: string }[],
): Promise<ThreadOrderLinkRow[]> {
  if (threads.length === 0) return [];
  const mailboxIds = threads.map((t) => t.mailboxId);
  const threadIds = threads.map((t) => t.gmailThreadId);
  return (
    (await db.execute(sql`
      SELECT l.id, l.mailbox_id, l.gmail_thread_id, l.printavo_order_id,
        coalesce(o.visual_id, l.visual_id) AS visual_id, l.source,
        o.nickname, o.order_type, o.status_name, o.total::text AS total
      FROM email_thread_orders l
      LEFT JOIN pv_orders o ON o.printavo_id = l.printavo_order_id
      WHERE NOT l.suppressed
        AND (l.mailbox_id, l.gmail_thread_id) IN (
          SELECT unnest(${sql`ARRAY[${sql.join(mailboxIds.map((m) => sql`${m}::uuid`), sql`, `)}]`}),
                 unnest(${sql`ARRAY[${sql.join(threadIds.map((t) => sql`${t}`), sql`, `)}]`})
        )
      ORDER BY visual_id DESC NULLS LAST
    `)) as unknown as Rows<ThreadOrderLinkRow>
  ).rows;
}

// ── Drill-down + deals report ────────────────────────────────────────

export interface EmailCustomerRow {
  customer_id: string;
  display_name: string;
  threads: number;
  messages: number;
  sent: number;
  received: number;
  last_email_at: string | Date;
}

/** Per-customer email volume in a range — the dashboard drill-down list. */
export async function emailCustomersList(
  range: { start: Date; end: Date; mailboxId?: string },
  limit = 100,
): Promise<EmailCustomerRow[]> {
  return (
    (await db.execute(sql`
      SELECT tc.printavo_customer_id AS customer_id,
        coalesce(nullif(c.company_name, ''), c.data->'primaryContact'->>'fullName', '(no name)') AS display_name,
        count(DISTINCT (m.mailbox_id, m.gmail_thread_id))::int AS threads,
        count(*)::int AS messages,
        count(*) FILTER (WHERE m.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE m.direction = 'inbound')::int AS received,
        max(m.internal_date) AS last_email_at
      FROM email_thread_customers tc
      JOIN email_messages m
        ON m.mailbox_id = tc.mailbox_id AND m.gmail_thread_id = tc.gmail_thread_id
      LEFT JOIN pv_customers c ON c.printavo_id = tc.printavo_customer_id
      WHERE m.excluded_reason IS NULL
        AND m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
        AND m.mailbox_id = ${range.mailboxId}::uuid
      GROUP BY 1, 2
      ORDER BY count(*) DESC
      LIMIT ${limit}
    `)) as unknown as Rows<EmailCustomerRow>
  ).rows;
}

export interface DealsReportRow {
  customer_id: string;
  display_name: string;
  threads: number;
  emails: number;
  invoices_won: number;
  revenue: string;
  last_invoice_at: string | Date | null;
}

/**
 * Email volume vs. invoices won per customer over a period. Printavo
 * invoices only — Chipply shell invoices are excluded, and Chipply store
 * revenue is never part of this. last_invoice_at is all-time (for the
 * time-sink test), while invoices_won/revenue honor the range.
 */
export async function dealsReport(range: { start: Date; end: Date; mailboxId?: string }): Promise<DealsReportRow[]> {
  return (
    (await db.execute(sql`
      WITH mail AS (
        SELECT tc.printavo_customer_id AS customer_id,
          count(DISTINCT (m.mailbox_id, m.gmail_thread_id))::int AS threads,
          count(*)::int AS emails
        FROM email_thread_customers tc
        JOIN email_messages m
          ON m.mailbox_id = tc.mailbox_id AND m.gmail_thread_id = tc.gmail_thread_id
        WHERE m.excluded_reason IS NULL
          AND m.internal_date >= ${range.start} AND m.internal_date < ${range.end}
          AND m.mailbox_id = ${range.mailboxId}::uuid
        GROUP BY 1
      ),
      won AS (
        SELECT o.customer_id,
          count(*) FILTER (WHERE o.invoice_at >= ${range.start} AND o.invoice_at < ${range.end})::int AS invoices_won,
          coalesce(sum(o.total) FILTER (WHERE o.invoice_at >= ${range.start} AND o.invoice_at < ${range.end}), 0) AS revenue,
          max(o.invoice_at) AS last_invoice_at
        FROM pv_orders o
        WHERE o.order_type = 'invoice' AND ${sql.raw(notChipplySql("o.nickname"))}
        GROUP BY 1
      )
      SELECT mail.customer_id,
        coalesce(nullif(c.company_name, ''), c.data->'primaryContact'->>'fullName', '(no name)') AS display_name,
        mail.threads, mail.emails,
        coalesce(won.invoices_won, 0) AS invoices_won,
        coalesce(won.revenue, 0)::text AS revenue,
        won.last_invoice_at
      FROM mail
      LEFT JOIN won ON won.customer_id = mail.customer_id
      LEFT JOIN pv_customers c ON c.printavo_id = mail.customer_id
      ORDER BY mail.emails DESC
    `)) as unknown as Rows<DealsReportRow>
  ).rows;
}
