import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  emailMailboxesTable,
  emailExclusionRulesTable,
  emailActivitySettingsTable,
} from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";
import {
  AddEmailMailboxBody,
  UpdateEmailMailboxBody,
  AddEmailExclusionBody,
  UpdateEmailActivitySettingsBody,
} from "@workspace/api-zod";
import { requireCapability } from "../middlewares/requireStaff";
import { authorizedMailboxIds, canReadMailbox } from "../lib/emailAccess/authorization";
import { logger } from "../lib/logger";
import { gmailConfigured, serviceAccountEmail } from "../lib/emailActivity/gmail";
import {
  runEmailSync,
  isEmailSyncActive,
  verifyMailbox,
  getEmailSettings,
  messageCounts,
} from "../lib/emailActivity/sync";
import { reclassifyAll } from "../lib/emailActivity/classify";
import {
  overviewStats,
  responseTimeStats,
  unansweredThreads,
  heatmapStats,
  filteredStats,
} from "../lib/emailActivity/stats";
import {
  runEmailMatching,
  customerThreads,
  customerEmailStats,
  threadOrderLinks,
  emailCustomersList,
  dealsReport,
} from "../lib/emailActivity/matching";
import { pool } from "@workspace/db";

/**
 * Email activity tracker — Gmail metadata sync config + mailbox-scoped stats.
 */

const router: IRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

interface MailboxRow {
  id: string;
  email: string;
  displayName: string | null;
  active: boolean;
  backfillCompletedAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string;
  lastSyncError: string | null;
}

function mailboxJson(m: MailboxRow, counts: Map<string, { total: number; filtered: number }>) {
  const c = counts.get(m.id);
  return {
    id: m.id,
    email: m.email,
    displayName: m.displayName,
    active: m.active,
    backfillComplete: m.backfillCompletedAt !== null,
    lastSyncAt: m.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: m.lastSyncStatus as "never" | "ok" | "error",
    lastSyncError: m.lastSyncError,
    messageCount: c?.total ?? 0,
    filteredCount: c?.filtered ?? 0,
  };
}

async function mailboxLookup(): Promise<Map<string, { email: string; displayName: string | null }>> {
  const rows = await db
    .select({
      id: emailMailboxesTable.id,
      email: emailMailboxesTable.email,
      displayName: emailMailboxesTable.displayName,
    })
    .from(emailMailboxesTable);
  return new Map(rows.map((r) => [r.id, { email: r.email, displayName: r.displayName }]));
}

function parseRange(req: Request, res: Response): { start: Date; end: Date; mailboxId?: string } | null {
  const start = new Date(String(req.query.start ?? ""));
  const end = new Date(String(req.query.end ?? ""));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    res.status(400).json({ error: "start and end must be valid dates" });
    return null;
  }
  // End date is inclusive day — bump to next midnight.
  end.setUTCDate(end.getUTCDate() + 1);
  const mailboxId = typeof req.query.mailboxId === "string" && req.query.mailboxId ? req.query.mailboxId : undefined;
  return { start, end, mailboxId };
}

async function authorizedMailboxId(
  req: Request,
  res: Response,
  mailboxId: string | undefined,
): Promise<string | null> {
  if (!mailboxId) {
    res.status(400).json({ error: "mailboxId is required" });
    return null;
  }
  // Avoid passing malformed IDs to the UUID casts in the query services.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mailboxId)) {
    res.status(404).json({ error: "Mailbox not found" });
    return null;
  }
  if (!req.staff || !(await canReadMailbox(req.staff, mailboxId))) {
    res.status(404).json({ error: "Mailbox not found" });
    return null;
  }
  return mailboxId;
}

// ── Status / setup ───────────────────────────────────────────────────

router.get("/email-activity/status", requireCapability("view_email_activity"), async (req, res) => {
  const [mailboxes, counts, settings] = await Promise.all([
    db
      .select()
      .from(emailMailboxesTable)
      .orderBy(asc(emailMailboxesTable.createdAt)),
    messageCounts(),
    getEmailSettings(),
  ]);
  const readableMailboxIds = new Set(await authorizedMailboxIds(req.staff!));
  const visibleMailboxes =
    req.staff?.role === "admin"
      ? mailboxes
      : mailboxes.filter((mailbox) => readableMailboxIds.has(mailbox.id));
  res.json({
    credentialsConfigured: gmailConfigured(),
    serviceAccountEmail: serviceAccountEmail(),
    syncActive: isEmailSyncActive(),
    mailboxes: visibleMailboxes.map((m) => ({
      ...mailboxJson(m, counts),
      readable: readableMailboxIds.has(m.id),
    })),
    settings: {
      unansweredThresholdHours: settings.unansweredThresholdHours,
      backfillDays: settings.backfillDays,
    },
  });
});

router.post("/email-activity/mailboxes", requireCapability("manage_email_configuration"), async (req, res) => {
  const parsed = AddEmailMailboxBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
  const email = parsed.data.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email address" });
  const [existing] = await db.select().from(emailMailboxesTable).where(eq(emailMailboxesTable.email, email)).limit(1);
  if (existing) return res.status(409).json({ error: "Mailbox is already tracked" });
  const [row] = await db
    .insert(emailMailboxesTable)
    .values({ email, displayName: parsed.data.displayName?.trim() || null })
    .returning();
  return res.status(201).json(mailboxJson(row!, new Map()));
});

router.patch("/email-activity/mailboxes/:id", requireCapability("manage_email_configuration"), async (req, res) => {
  const parsed = UpdateEmailMailboxBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
  const updates: Partial<{ displayName: string | null; active: boolean }> = {};
  if ("displayName" in parsed.data) updates.displayName = parsed.data.displayName?.trim() || null;
  if (parsed.data.active !== undefined) updates.active = parsed.data.active;
  const [row] = await db
    .update(emailMailboxesTable)
    .set(updates)
    .where(eq(emailMailboxesTable.id, String(req.params.id)))
    .returning();
  if (!row) return res.status(404).json({ error: "Mailbox not found" });
  const counts = await messageCounts();
  return res.json(mailboxJson(row, counts));
});

router.delete("/email-activity/mailboxes/:id", requireCapability("manage_email_configuration"), async (req, res) => {
  const [row] = await db
    .delete(emailMailboxesTable)
    .where(eq(emailMailboxesTable.id, String(req.params.id)))
    .returning({ id: emailMailboxesTable.id });
  if (!row) return res.status(404).json({ error: "Mailbox not found" });
  return res.status(204).end();
});

router.post("/email-activity/mailboxes/:id/verify", requireCapability("manage_email_configuration"), async (req, res) => {
  const [row] = await db
    .select()
    .from(emailMailboxesTable)
    .where(eq(emailMailboxesTable.id, String(req.params.id)))
    .limit(1);
  if (!row) return res.status(404).json({ error: "Mailbox not found" });
  return res.json(await verifyMailbox(row.email));
});

router.post("/email-activity/sync", requireCapability("manage_email_configuration"), async (_req, res) => {
  if (isEmailSyncActive()) return res.json({ ran: false, message: "Email sync already running" });
  // Kick off in the background; the status endpoint reports progress.
  const promise = runEmailSync(logger);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1500));
  const quick = await Promise.race([promise, timeout]);
  promise.catch((err) => logger.error({ err }, "manual email sync failed"));
  return res.json(quick ?? { ran: true, message: "Sync started — watch mailbox status for progress" });
});

// ── Exclusions ───────────────────────────────────────────────────────

router.get("/email-activity/exclusions", requireCapability("manage_email_configuration"), async (_req, res) => {
  const rules = await db
    .select()
    .from(emailExclusionRulesTable)
    .orderBy(desc(emailExclusionRulesTable.createdAt));
  res.json(
    rules.map((r) => ({
      id: r.id,
      kind: r.kind as "address" | "domain",
      value: r.value,
      note: r.note,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

router.post("/email-activity/exclusions", requireCapability("manage_email_configuration"), async (req, res) => {
  const parsed = AddEmailExclusionBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
  const kind = parsed.data.kind;
  const value = parsed.data.value.trim().toLowerCase().replace(/^@/, "");
  if (kind === "address" && !EMAIL_RE.test(value)) return res.status(400).json({ error: "Invalid email address" });
  if (kind === "domain" && !DOMAIN_RE.test(value)) return res.status(400).json({ error: "Invalid domain" });
  try {
    const [row] = await db
      .insert(emailExclusionRulesTable)
      .values({ kind, value, note: parsed.data.note?.trim() || null, createdByEmail: req.staff?.email ?? null })
      .returning();
    const reclassified = await reclassifyAll();
    logger.info({ kind, value, reclassified }, "email exclusion rule added");
    return res.status(201).json({
      id: row!.id,
      kind: row!.kind as "address" | "domain",
      value: row!.value,
      note: row!.note,
      createdByEmail: row!.createdByEmail,
      createdAt: row!.createdAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof Error && /duplicate key/i.test(err.message)) {
      return res.status(409).json({ error: "That rule already exists" });
    }
    throw err;
  }
});

router.delete("/email-activity/exclusions/:id", requireCapability("manage_email_configuration"), async (req, res) => {
  const [row] = await db
    .delete(emailExclusionRulesTable)
    .where(eq(emailExclusionRulesTable.id, String(req.params.id)))
    .returning({ id: emailExclusionRulesTable.id });
  if (!row) return res.status(404).json({ error: "Rule not found" });
  const reclassified = await reclassifyAll();
  logger.info({ ruleId: row.id, reclassified }, "email exclusion rule removed");
  return res.status(204).end();
});

// ── Settings ─────────────────────────────────────────────────────────

router.put("/email-activity/settings", requireCapability("manage_email_configuration"), async (req, res) => {
  const parsed = UpdateEmailActivitySettingsBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
  await getEmailSettings(); // ensure the row exists
  const updates: Partial<{ unansweredThresholdHours: number; backfillDays: number }> = {};
  if (parsed.data.unansweredThresholdHours !== undefined)
    updates.unansweredThresholdHours = parsed.data.unansweredThresholdHours;
  if (parsed.data.backfillDays !== undefined) updates.backfillDays = parsed.data.backfillDays;
  const [row] = await db
    .update(emailActivitySettingsTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(emailActivitySettingsTable.id, 1))
    .returning();
  return res.json({ unansweredThresholdHours: row!.unansweredThresholdHours, backfillDays: row!.backfillDays });
});

// ── Stats ────────────────────────────────────────────────────────────

router.get("/email-activity/stats", requireCapability("view_email_activity"), async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const mailboxId = await authorizedMailboxId(req, res, range.mailboxId);
  if (!mailboxId) return;
  range.mailboxId = mailboxId;
  const granularity = String(req.query.granularity ?? "daily") as "daily" | "weekly" | "monthly";
  if (!["daily", "weekly", "monthly"].includes(granularity))
    return res.status(400).json({ error: "Invalid granularity" });
  const [{ perMailbox, series, depth }, lookup] = await Promise.all([
    overviewStats(range, granularity),
    mailboxLookup(),
  ]);
  const depthByMailbox = new Map(depth.map((d) => [d.mailbox_id, d]));
  const people = perMailbox.map((p) => {
    const d = depthByMailbox.get(p.mailbox_id);
    const info = lookup.get(p.mailbox_id);
    return {
      mailboxId: p.mailbox_id,
      email: info?.email ?? null,
      displayName: info?.displayName ?? null,
      sent: p.sent,
      received: p.received,
      threads: p.threads,
      filtered: p.filtered,
      avgThreadDepth: d ? Number(d.avg_depth) : null,
      depthBuckets: d ? [d.d1, d.d2_3, d.d4_6, d.d7_plus] : [0, 0, 0, 0],
    };
  });
  const team = {
    mailboxId: null,
    email: null,
    displayName: "Team",
    sent: people.reduce((s, p) => s + p.sent, 0),
    received: people.reduce((s, p) => s + p.received, 0),
    threads: people.reduce((s, p) => s + p.threads, 0),
    filtered: people.reduce((s, p) => s + p.filtered, 0),
    avgThreadDepth: null as number | null,
    depthBuckets: [0, 1, 2, 3].map((i) => people.reduce((s, p) => s + (p.depthBuckets[i] ?? 0), 0)),
  };
  return res.json({
    granularity,
    people,
    team,
    series: series.map((s) => ({ bucket: s.bucket, mailboxId: s.mailbox_id, sent: s.sent, received: s.received })),
  });
});

router.get("/email-activity/response-times", requireCapability("view_email_activity"), async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const mailboxId = await authorizedMailboxId(req, res, range.mailboxId);
  if (!mailboxId) return;
  range.mailboxId = mailboxId;
  const [rows, lookup] = await Promise.all([responseTimeStats(range), mailboxLookup()]);
  // The pooled row (mailbox_id null) is a true team percentile over the same
  // filtered thread population — it honors any mailboxId filter.
  const pooledRow = rows.find((r) => r.mailbox_id == null);
  const people = rows.filter((r) => r.mailbox_id != null).map((r) => {
    const info = lookup.get(r.mailbox_id!);
    return {
      mailboxId: r.mailbox_id!,
      email: info?.email ?? null,
      displayName: info?.displayName ?? null,
      repliedThreads: r.replied_threads,
      medianSecs: r.median_secs != null ? Number(r.median_secs) : null,
      p90Secs: r.p90_secs != null ? Number(r.p90_secs) : null,
      distribution: [r.b_lt15m, r.b_15m_1h, r.b_1h_4h, r.b_4h_24h, r.b_gt24h],
    };
  });
  return res.json({
    people,
    team: {
      mailboxId: null,
      email: null,
      displayName: "Team",
      repliedThreads: pooledRow?.replied_threads ?? 0,
      medianSecs: pooledRow?.median_secs != null ? Number(pooledRow.median_secs) : null,
      p90Secs: pooledRow?.p90_secs != null ? Number(pooledRow.p90_secs) : null,
      distribution: pooledRow
        ? [pooledRow.b_lt15m, pooledRow.b_15m_1h, pooledRow.b_1h_4h, pooledRow.b_4h_24h, pooledRow.b_gt24h]
        : [0, 0, 0, 0, 0],
    },
  });
});

router.get("/email-activity/unanswered", requireCapability("view_email_activity"), async (req, res) => {
  const settings = await getEmailSettings();
  const mailboxId = await authorizedMailboxId(
    req,
    res,
    typeof req.query.mailboxId === "string" && req.query.mailboxId ? req.query.mailboxId : undefined,
  );
  if (!mailboxId) return;
  const [rows, lookup] = await Promise.all([
    unansweredThreads(settings.unansweredThresholdHours, mailboxId),
    mailboxLookup(),
  ]);
  res.json({
    thresholdHours: settings.unansweredThresholdHours,
    threads: rows.map((r) => ({
      mailboxId: r.mailbox_id,
      email: lookup.get(r.mailbox_id)?.email ?? null,
      gmailThreadId: r.gmail_thread_id,
      subject: r.subject,
      counterpart: r.counterpart_address,
      lastInboundAt: new Date(r.last_inbound_at).toISOString(),
      ageHours: Number(r.age_hours),
      messageCount: r.msg_count,
    })),
  });
});

router.get("/email-activity/heatmap", requireCapability("view_email_activity"), async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const mailboxId = await authorizedMailboxId(req, res, range.mailboxId);
  if (!mailboxId) return;
  range.mailboxId = mailboxId;
  const cells = await heatmapStats(range);
  res.json({ cells: cells.map((c) => ({ dow: c.dow, hour: c.hour, sent: c.sent, received: c.received })) });
});

router.get("/email-activity/filtered", requireCapability("view_email_activity"), async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const mailboxId = await authorizedMailboxId(req, res, range.mailboxId);
  if (!mailboxId) return;
  range.mailboxId = mailboxId;
  const [{ breakdown, sample }, lookup] = await Promise.all([filteredStats(range), mailboxLookup()]);
  res.json({
    total: breakdown.reduce((s, b) => s + b.count, 0),
    breakdown: breakdown.map((b) => ({ reason: b.reason, count: b.count })),
    sample: sample.map((s) => ({
      mailboxId: s.mailbox_id,
      email: lookup.get(s.mailbox_id)?.email ?? null,
      subject: s.subject,
      counterpart: s.counterpart_address,
      reason: s.excluded_reason,
      direction: s.direction,
      internalDate: new Date(s.internal_date).toISOString(),
    })),
  });
});

// ── Customer / invoice correlation ───────────────────────────────────

router.post("/email-activity/match", requireCapability("manage_email_configuration"), async (_req, res) => {
  const result = await runEmailMatching(logger);
  res.json(result);
});

router.get("/email-activity/customers", requireCapability("view_email_activity"), async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const mailboxId = await authorizedMailboxId(req, res, range.mailboxId);
  if (!mailboxId) return;
  range.mailboxId = mailboxId;
  const rows = await emailCustomersList(range);
  res.json({
    customers: rows.map((r) => ({
      customerId: r.customer_id,
      displayName: r.display_name,
      threads: r.threads,
      messages: r.messages,
      sent: r.sent,
      received: r.received,
      lastEmailAt: new Date(r.last_email_at).toISOString(),
    })),
  });
});

router.get("/email-activity/customers/:customerId", requireCapability("view_email_activity"), async (req, res) => {
  const customerId = String(req.params.customerId);
  if (!/^\d+$/.test(customerId)) return res.status(404).json({ error: "Customer not found" });
  const mailboxId = await authorizedMailboxId(
    req,
    res,
    typeof req.query.mailboxId === "string" && req.query.mailboxId ? req.query.mailboxId : undefined,
  );
  if (!mailboxId) return;
  const [threads, stats, lookup] = await Promise.all([
    customerThreads(customerId, mailboxId),
    customerEmailStats(customerId, mailboxId),
    mailboxLookup(),
  ]);
  const links = await threadOrderLinks(
    threads.map((t) => ({ mailboxId: t.mailbox_id, gmailThreadId: t.gmail_thread_id })),
  );
  const linksByThread = new Map<string, typeof links>();
  for (const l of links) {
    const key = `${l.mailbox_id}|${l.gmail_thread_id}`;
    const arr = linksByThread.get(key) ?? [];
    arr.push(l);
    linksByThread.set(key, arr);
  }
  return res.json({
    stats: {
      threadCount: stats.thread_count,
      messageCount: stats.message_count,
      sent: stats.sent,
      received: stats.received,
      lastEmailAt: stats.last_email_at ? new Date(stats.last_email_at).toISOString() : null,
      repliedThreads: stats.replied_threads,
      medianSecs: stats.median_secs != null ? Number(stats.median_secs) : null,
      p90Secs: stats.p90_secs != null ? Number(stats.p90_secs) : null,
    },
    threads: threads.map((t) => ({
      mailboxId: t.mailbox_id,
      mailboxEmail: lookup.get(t.mailbox_id)?.email ?? null,
      gmailThreadId: t.gmail_thread_id,
      subject: t.subject ?? "",
      counterpart: t.counterpart_address,
      messageCount: t.msg_count,
      sent: t.sent,
      received: t.received,
      firstAt: new Date(t.first_at).toISOString(),
      lastAt: new Date(t.last_at).toISOString(),
      orderLinks: (linksByThread.get(`${t.mailbox_id}|${t.gmail_thread_id}`) ?? []).map((l) => ({
        id: l.id,
        printavoOrderId: l.printavo_order_id,
        visualId: l.visual_id,
        source: l.source as "auto" | "manual",
        nickname: l.nickname,
        orderType: l.order_type,
        statusName: l.status_name,
        total: l.total != null ? Number(l.total) : null,
      })),
    })),
  });
});

router.post("/email-activity/thread-links", requireCapability("manage_email_configuration"), async (req, res) => {
  const mailboxId = typeof req.body?.mailboxId === "string" ? req.body.mailboxId : "";
  const gmailThreadId = typeof req.body?.gmailThreadId === "string" ? req.body.gmailThreadId : "";
  const visualId = Number(req.body?.visualId);
  if (!mailboxId || !gmailThreadId || !Number.isInteger(visualId) || visualId <= 0) {
    return res.status(400).json({ error: "mailboxId, gmailThreadId and a positive integer visualId are required" });
  }
  // Validate against synced orders — prefer invoice, then most recent.
  const or = await pool.query(
    `SELECT printavo_id, visual_id FROM pv_orders
      WHERE visual_id = $1
      ORDER BY (order_type = 'invoice') DESC, invoice_at DESC NULLS LAST, printavo_id DESC
      LIMIT 1`,
    [visualId],
  );
  if (or.rows.length === 0) {
    return res.status(404).json({ error: `No synced order with visual ID #${visualId}` });
  }
  const order = or.rows[0];
  // Upsert: revive a suppressed auto row as a manual link.
  const ir = await pool.query(
    `INSERT INTO email_thread_orders
       (mailbox_id, gmail_thread_id, printavo_order_id, visual_id, source, suppressed, created_by_email)
     VALUES ($1::uuid, $2, $3, $4, 'manual', false, $5)
     ON CONFLICT (mailbox_id, gmail_thread_id, printavo_order_id) DO UPDATE
        SET suppressed = false, source = 'manual', created_by_email = excluded.created_by_email
     RETURNING id, printavo_order_id, visual_id, source`,
    [mailboxId, gmailThreadId, order.printavo_id, order.visual_id, req.staff?.email ?? null],
  );
  const row = ir.rows[0];
  return res.status(201).json({
    id: row.id as string,
    printavoOrderId: row.printavo_order_id as string,
    visualId: row.visual_id as number,
    source: row.source as "auto" | "manual",
  });
});

router.delete("/email-activity/thread-links/:id", requireCapability("manage_email_configuration"), async (req, res) => {
  // Auto links are suppressed (so the matching pass can't re-add them);
  // manual links are deleted outright.
  const r = await pool.query(
    `WITH target AS (SELECT id, source FROM email_thread_orders WHERE id = $1::uuid),
     del AS (DELETE FROM email_thread_orders
              WHERE id IN (SELECT id FROM target WHERE source = 'manual') RETURNING id),
     sup AS (UPDATE email_thread_orders SET suppressed = true
              WHERE id IN (SELECT id FROM target WHERE source = 'auto') RETURNING id)
     SELECT (SELECT count(*) FROM del) + (SELECT count(*) FROM sup) AS n`,
    [req.params.id],
  );
  if (Number(r.rows[0]?.n ?? 0) === 0) return res.status(404).json({ error: "Link not found" });
  return res.status(204).end();
});

router.get("/email-activity/deals-report", requireCapability("view_email_activity"), async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const mailboxId = await authorizedMailboxId(req, res, range.mailboxId);
  if (!mailboxId) return;
  range.mailboxId = mailboxId;
  const rows = await dealsReport(range);
  const totalEmails = rows.reduce((s, r) => s + r.emails, 0);
  const totalWon = rows.reduce((s, r) => s + r.invoices_won, 0);
  const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue), 0);
  // Time sink: meaningful email volume in the period, but no invoice in the
  // period AND nothing won in the 90 days before the period's end.
  const staleCutoff = new Date(range.end.getTime() - 90 * 86400_000);
  res.json({
    summary: {
      customers: rows.length,
      emails: totalEmails,
      invoicesWon: totalWon,
      revenue: totalRevenue,
      emailsPerWonInvoice: totalWon > 0 ? Math.round((totalEmails / totalWon) * 10) / 10 : null,
    },
    rows: rows.map((r) => ({
      customerId: r.customer_id,
      displayName: r.display_name,
      threads: r.threads,
      emails: r.emails,
      invoicesWon: r.invoices_won,
      revenue: Number(r.revenue),
      emailsPerWonInvoice:
        r.invoices_won > 0 ? Math.round((r.emails / r.invoices_won) * 10) / 10 : null,
      lastInvoiceAt: r.last_invoice_at
        ? new Date(r.last_invoice_at).toISOString().slice(0, 10)
        : null,
      timeSink:
        r.emails >= 10 &&
        r.invoices_won === 0 &&
        (r.last_invoice_at == null || new Date(r.last_invoice_at) < staleCutoff),
    })),
  });
});

export default router;
