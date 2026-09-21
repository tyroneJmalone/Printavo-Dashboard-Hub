import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { pool } from "@workspace/db";
import {
  authorizedMailboxIds,
  canReadMailbox,
  requireThreadRead,
} from "../lib/emailAccess/authorization";
import { runMissiveSync } from "../lib/missive/sync";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const limitOf = (value: unknown) =>
  Math.min(100, Math.max(1, Number.parseInt(String(value ?? 25), 10) || 25));
const offsetOf = (value: unknown) =>
  Math.max(0, Number.parseInt(String(value ?? 0), 10) || 0);

function authorizedSql(capabilities: readonly ("read" | "search" | "cite")[]) {
  const capabilityChecks = capabilities
    .map((capability) => `AND '${capability}' = ANY(tg.capabilities)`)
    .join("\n");
  return `(
  p.owner_staff_id = $1::uuid
  OR (
    p.protected = false
    AND p.visibility = 'workspace'
    AND EXISTS (
      SELECT 1 FROM staff_users su
      WHERE su.id=$1::uuid AND su.role='staff'
    )
  )
  OR (
    p.visibility IN ('group','workspace')
    AND EXISTS (
      SELECT 1 FROM email_access_group_mailboxes gm
      JOIN email_access_group_members gu ON gu.group_id = gm.group_id
      WHERE gm.mailbox_id = t.mailbox_id AND gu.staff_id = $1::uuid
    )
  )
  OR EXISTS (
    SELECT 1 FROM correspondence_thread_grants tg
    WHERE tg.thread_id = t.id AND tg.staff_id = $1::uuid
      AND tg.active = true AND tg.revoked_at IS NULL
      AND (tg.expires_at IS NULL OR tg.expires_at > now())
      ${capabilityChecks}
  )
)`;
}

const AUTHORIZED_READ_SQL = authorizedSql(["read"]);
const AUTHORIZED_SEARCH_SQL = authorizedSql(["read", "search"]);
const AUTHORIZED_AI_SQL = authorizedSql(["read", "search", "cite"]);

function threadJson(row: Record<string, unknown>) {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    gmailThreadId: row.gmail_thread_id ?? "",
    subject: row.subject,
    counterpart: row.counterpart,
    counterpartEmail: row.counterpart_email,
    lastMessageAt: new Date(row.last_message_at as string | Date).toISOString(),
    firstMessageAt: row.first_message_at
      ? new Date(row.first_message_at as string | Date).toISOString()
      : null,
    messageCount: row.message_count,
    snippet: row.snippet,
    status: row.status,
    participants: row.participants ?? [],
    labels: row.labels ?? [],
    inboxes: row.inboxes ?? [],
    collaborators: row.collaborators ?? [],
    hydrationState: row.hydration_state,
    webUrl: row.web_url,
  };
}

async function authorizedThreads(
  staffId: string,
  isAdmin: boolean,
  query: string,
  limit: number,
  offset: number,
  options: {
    folder?: "inbox" | "sent" | "archived";
    mailboxId?: string;
    senderMailboxIds?: string[];
  } = {},
) {
  const term = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  const authorization = isAdmin
    ? "($1::uuid IS NOT NULL)"
    : query
      ? AUTHORIZED_SEARCH_SQL
      : AUTHORIZED_READ_SQL;
  const result = await pool.query(
    `SELECT t.*, count(*) OVER()::int AS total
       FROM correspondence_threads t
       LEFT JOIN email_mailbox_policies p ON p.mailbox_id = t.mailbox_id
      WHERE ${authorization}
        AND ($2 = '' OR t.subject ILIKE $3 ESCAPE '\\'
          OR t.counterpart ILIKE $3 ESCAPE '\\'
          OR t.counterpart_email ILIKE $3 ESCAPE '\\'
          OR t.snippet ILIKE $3 ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM correspondence_messages sm
             WHERE sm.thread_id=t.id
               AND (sm.subject ILIKE $3 ESCAPE '\\' OR sm.body_text ILIKE $3 ESCAPE '\\')
          ))
        AND (
          $6::uuid IS NULL
          OR $7 = 'sent'
          OR t.mailbox_id = $6::uuid
        )
        AND (
          $7 = ''
          OR ($7 = 'inbox' AND t.status = 'open')
          OR ($7 = 'archived' AND t.status = 'archived')
          OR ($7 = 'sent' AND EXISTS (
            SELECT 1
              FROM correspondence_messages sent_message
              JOIN email_mailboxes sent_mailbox
                ON lower(sent_mailbox.email)=lower(sent_message.from_address)
             WHERE sent_message.thread_id=t.id
               AND (
                 ($6::uuid IS NOT NULL AND sent_mailbox.id=$6::uuid)
                 OR (
                   $6::uuid IS NULL
                   AND (
                     $8::uuid[] IS NULL
                     OR sent_mailbox.id=ANY($8::uuid[])
                     OR EXISTS (
                       SELECT 1 FROM correspondence_thread_grants sent_grant
                        WHERE sent_grant.thread_id=t.id
                          AND sent_grant.staff_id=$1::uuid
                          AND sent_grant.active=true
                          AND sent_grant.revoked_at IS NULL
                          AND (sent_grant.expires_at IS NULL OR sent_grant.expires_at > now())
                          AND 'read'=ANY(sent_grant.capabilities)
                     )
                   )
                 )
               )
          ))
        )
      ORDER BY t.last_message_at DESC LIMIT $4 OFFSET $5`,
    [
      staffId,
      query,
      term,
      limit,
      offset,
      query ? null : options.mailboxId ?? null,
      query ? "" : options.folder ?? "",
      options.senderMailboxIds ?? null,
    ],
  );
  return {
    threads: result.rows.map(threadJson),
    total: result.rows[0]?.total ?? 0,
  };
}

router.get("/correspondence/mailboxes", async (req, res) => {
  try {
    const allowed = await authorizedMailboxIds(req.staff!);
    const result = await pool.query<{
      id: string;
      email: string;
      display_name: string | null;
    }>(
      `SELECT id, email, display_name
         FROM email_mailboxes
        WHERE id = ANY($1::uuid[])
        ORDER BY lower(coalesce(display_name, email)), lower(email)`,
      [allowed],
    );
    res.json({
      mailboxes: result.rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Correspondence mailbox list failed");
    res.status(500).json({ error: "Unable to load correspondence mailboxes" });
  }
});

router.get("/correspondence/threads", async (req, res) => {
  try {
    const rawQuery = req.query.query ?? req.query.q;
    const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 300) : "";
    const rawFolder = req.query.folder;
    if (
      rawFolder !== undefined &&
      (typeof rawFolder !== "string" ||
        !["inbox", "sent", "archived"].includes(rawFolder))
    ) {
      return void res.status(400).json({ error: "Invalid correspondence folder" });
    }
    const folder = rawFolder as "inbox" | "sent" | "archived" | undefined;
    const rawMailboxId = req.query.mailboxId;
    if (
      rawMailboxId !== undefined &&
      (typeof rawMailboxId !== "string" || !UUID.test(rawMailboxId))
    ) {
      return void res.status(404).json({ error: "Mailbox not found or not authorized" });
    }
    const mailboxId = rawMailboxId as string | undefined;
    // A text search is intentionally global across the actor's authorized
    // correspondence. Folder and mailbox selectors only scope browsing.
    if (!query && mailboxId && !(await canReadMailbox(req.staff!, mailboxId))) {
      return void res.status(404).json({ error: "Mailbox not found or not authorized" });
    }
    const senderMailboxIds =
      !query && folder === "sent" && !mailboxId && req.staff!.role !== "admin"
        ? await authorizedMailboxIds(req.staff!)
        : undefined;
    const limit = limitOf(req.query.limit);
    const offset = offsetOf(req.query.offset);
    const data = await authorizedThreads(
      req.staff!.id,
      req.staff!.role === "admin",
      query,
      limit,
      offset,
      { folder, mailboxId, senderMailboxIds },
    );
    res.json({ ...data, hasMore: offset + data.threads.length < data.total });
  } catch (err) {
    req.log.error({ err }, "Correspondence thread list failed");
    res.status(500).json({ error: "Unable to load correspondence" });
  }
});

router.post("/correspondence/search", async (req, res) => {
  const query =
    typeof req.body?.query === "string" ? req.body.query.trim().slice(0, 300) : "";
  if (!query) return void res.status(400).json({ error: "Search query is required" });
  try {
    res.json(
      await authorizedThreads(
        req.staff!.id,
        req.staff!.role === "admin",
        query,
        limitOf(req.body?.limit),
        offsetOf(req.body?.offset),
      ),
    );
  } catch (err) {
    req.log.error({ err }, "Correspondence search failed");
    res.status(500).json({ error: "Search failed" });
  }
});

router.get("/correspondence/threads/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) return void res.status(404).json({ error: "Thread not found" });
  try {
    await requireThreadRead(req.staff!, id);
    const [thread, messages, comments, links] = await Promise.all([
      pool.query("SELECT * FROM correspondence_threads WHERE id=$1::uuid", [id]),
      pool.query(
        "SELECT * FROM correspondence_messages WHERE thread_id=$1::uuid ORDER BY delivered_at ASC",
        [id],
      ),
      pool.query(
        "SELECT * FROM correspondence_comments WHERE thread_id=$1::uuid ORDER BY created_at ASC",
        [id],
      ),
      pool.query(
        `SELECT o.id, o.printavo_order_id, o.visual_id, o.source,
                pv.nickname, pv.order_type, pv.total, s.name AS status_name
           FROM correspondence_threads t
           JOIN email_thread_orders o
             ON o.mailbox_id=t.mailbox_id AND o.gmail_thread_id=t.gmail_thread_id
            AND o.suppressed=false
           LEFT JOIN pv_orders pv ON pv.printavo_id=o.printavo_order_id
           LEFT JOIN pv_statuses s ON s.printavo_id=pv.status_id
          WHERE t.id=$1::uuid`,
        [id],
      ),
    ]);
    if (!thread.rows[0]) return void res.status(404).json({ error: "Thread not found" });
    res.json({
      thread: threadJson(thread.rows[0]),
      messages: messages.rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        gmailMessageId: row.gmail_message_id ?? "",
        from: row.from_address,
        fromName: row.from_name,
        to: row.to_addresses ?? [],
        cc: row.cc_addresses ?? [],
        bcc: row.bcc_addresses ?? [],
        subject: row.subject,
        date: new Date(row.delivered_at).toISOString(),
        snippet: row.snippet,
        bodyText: row.body_text,
        attachments: row.attachments ?? [],
      })),
      comments: comments.rows.map((row) => ({
        id: row.id,
        authorName: row.author_name,
        authorEmail: row.author_email,
        bodyText: row.body_text,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      orderLinks: links.rows,
    });
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return void res.status(404).json({ error: "Thread not found" });
    }
    req.log.error({ err }, "Correspondence thread load failed");
    res.status(500).json({ error: "Unable to load thread" });
  }
});

router.post("/correspondence/ai-search", async (req, res) => {
  const query =
    typeof req.body?.query === "string" ? req.body.query.trim().slice(0, 2_000) : "";
  if (!query) return void res.status(400).json({ error: "Search query is required" });
  try {
    const settings = await pool.query<{ ai_processing_enabled: boolean }>(
      "SELECT ai_processing_enabled FROM email_access_settings WHERE id=1",
    );
    if (settings.rows[0]?.ai_processing_enabled === false) {
      return void res.status(403).json({ error: "AI correspondence search is disabled" });
    }
    const term = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    const authorization =
      req.staff!.role === "admin"
        ? "($1::uuid IS NOT NULL)"
        : AUTHORIZED_AI_SQL;
    const rows = await pool.query(
      `SELECT m.id AS source_id, t.id AS thread_id, t.subject, t.counterpart,
              m.from_address, m.delivered_at, left(m.body_text, 5000) AS content
         FROM correspondence_threads t
         LEFT JOIN email_mailbox_policies p ON p.mailbox_id=t.mailbox_id
         JOIN correspondence_messages m ON m.thread_id=t.id
        WHERE ${authorization}
          AND (t.subject ILIKE $2 ESCAPE '\\' OR t.counterpart ILIKE $2 ESCAPE '\\'
            OR m.body_text ILIKE $2 ESCAPE '\\' OR m.subject ILIKE $2 ESCAPE '\\')
        ORDER BY m.delivered_at DESC LIMIT 40`,
      [req.staff!.id, term],
    );
    const sources = rows.rows.map((row) => ({
      id: row.source_id as string,
      threadId: row.thread_id as string,
      subject: row.subject,
      counterpart: row.counterpart,
      from: row.from_address,
      date: new Date(row.delivered_at).toISOString(),
      content: row.content,
    }));
    if (!sources.length) {
      return void res.json({
        results: [],
        summary: "No authorized correspondence matched.",
      });
    }
    const completion = await openai.chat.completions.create(
      {
        model: "gpt-5.6-terra",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'Answer only from SOURCES. Return JSON {"answer":"plain text with [source:UUID] citations","sourceIds":["UUID"]}. Every factual claim needs a citation. Never infer or mention inaccessible material.',
          },
          {
            role: "user",
            content: `Question: ${query}\nSOURCES:\n${JSON.stringify(sources)}`,
          },
        ],
        max_completion_tokens: 1200,
      },
      { timeout: 25_000 },
    );
    const raw = completion.choices[0]?.message.content ?? "{}";
    const parsed = JSON.parse(raw) as { answer?: unknown; sourceIds?: unknown };
    const summary = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    const sourceIds = Array.isArray(parsed.sourceIds)
      ? parsed.sourceIds.filter((id): id is string => typeof id === "string")
      : [];
    const allowed = new Set(sources.map((source) => source.id.toLowerCase()));
    const citedInAnswer = [...summary.matchAll(/\[source:([0-9a-f-]{36})\]/gi)].map(
      (match) => match[1].toLowerCase(),
    );
    const declared = new Set(sourceIds.map((id) => id.toLowerCase()));
    const cited = new Set(citedInAnswer);
    if (
      !summary ||
      cited.size === 0 ||
      sourceIds.some((id) => !allowed.has(id.toLowerCase())) ||
      citedInAnswer.some((id) => !allowed.has(id)) ||
      declared.size !== cited.size ||
      [...declared].some((id) => !cited.has(id))
    ) {
      return void res.status(502).json({ error: "AI returned an invalid citation" });
    }
    const chosen = new Set([...sourceIds.map((id) => id.toLowerCase()), ...citedInAnswer]);
    await pool.query(
      `INSERT INTO correspondence_audit (staff_id, action, query, source_ids, result_count)
       VALUES ($1::uuid, 'ai_search', $2, $3::text[], $4)`,
      [req.staff!.id, query, [...chosen], chosen.size],
    );
    res.json({
      results: sources.filter((source) => chosen.has(source.id.toLowerCase())),
      summary,
    });
  } catch (err) {
    req.log.error({ err }, "Correspondence AI search failed");
    res.status(503).json({ error: "AI search is temporarily unavailable" });
  }
});

router.post("/correspondence/history-import", async (req, res) => {
  const emails = Array.isArray(req.body?.emails)
    ? req.body.emails
        .filter(
          (value: unknown): value is string =>
            typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
        )
        .map((value: string) => value.toLowerCase())
    : [];
  if (!emails.length) {
    return void res.status(400).json({ error: "At least one mailbox email is required" });
  }
  const fromDate =
    typeof req.body?.fromDate === "string" ? new Date(req.body.fromDate) : null;
  const toDate = typeof req.body?.toDate === "string" ? new Date(req.body.toDate) : null;
  if (
    (fromDate && Number.isNaN(fromDate.getTime())) ||
    (toDate && Number.isNaN(toDate.getTime())) ||
    (fromDate && toDate && fromDate >= toDate)
  ) {
    return void res.status(400).json({ error: "Invalid history import date range" });
  }
  const allowed = await authorizedMailboxIds(req.staff!);
  const rows = await pool.query<{ email: string }>(
    "SELECT email FROM email_mailboxes WHERE id = ANY($1::uuid[]) AND lower(email) = ANY($2::text[])",
    [allowed, emails],
  );
  if (rows.rows.length !== new Set(emails).size) {
    return void res.status(404).json({ error: "Mailbox not found" });
  }
  const job_id = crypto.randomUUID();
  void runMissiveSync(req.log, {
    fullHistoryForEmails: emails,
    fromDate: fromDate?.toISOString(),
    toDate: toDate?.toISOString(),
  }).catch((err) =>
    req.log.error({ err, jobId: job_id }, "Correspondence history import failed"),
  );
  res.status(202).json({ started: true, job_id });
});

export default router;