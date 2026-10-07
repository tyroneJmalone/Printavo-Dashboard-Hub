import { easternCalendarRange } from "../lib/hub/reportCalendar";
import { Router, type IRouter } from "express";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  aiAuditEventsTable,
  draftPatternEventsTable,
  type DraftPatternEvent,
} from "@workspace/db";
import {
  GetDraftPatternSummaryResponse,
  GetMissiveWebhookSettingsResponse,
  ListDraftPatternEventsQueryParams,
  ListDraftPatternEventsResponse,
  ReviewDraftPatternEventParams,
  ReviewDraftPatternEventBody,
  ReviewDraftPatternEventResponse,
  RotateMissiveWebhookSecretResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import {
  getWebhookSecret,
  listPatternEvents,
  rotateWebhookSecret,
} from "../lib/draftPatterns/service";

/**
 * Drafting-pattern measurement (admin, alongside the AI Connections page):
 * Missive webhook settings, the Pattern B/C event log with timing +
 * pass-criteria scoring, and the A/B/C comparison summary that merges
 * ai_audit_events accuracy/outcome scoring with Pattern B ordering stats.
 */
const router: IRouter = Router();
router.use("/ai-context", requireAdmin);

function apiBaseUrl(): string {
  const domain = (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim();
  return domain ? `https://${domain}` : "";
}

router.get("/ai-context/webhooks", async (_req, res): Promise<void> => {
  const secret = await getWebhookSecret();
  const base = apiBaseUrl();
  res.json(
    GetMissiveWebhookSettingsResponse.parse({
      configured: Boolean(secret),
      secret,
      contextNoteUrl: base ? `${base}/api/missive/webhooks/context-note` : "/api/missive/webhooks/context-note",
      voiceDraftUrl: base ? `${base}/api/missive/webhooks/voice-draft` : "/api/missive/webhooks/voice-draft",
    }),
  );
});

router.post("/ai-context/webhooks/rotate", async (req, res): Promise<void> => {
  const secret = await rotateWebhookSecret();
  req.log.info({ by: req.staff?.email }, "Missive webhook secret rotated");
  res.json(RotateMissiveWebhookSecretResponse.parse({ secret }));
});

function eventDto(row: DraftPatternEvent) {
  return {
    id: row.id,
    pattern: row.pattern,
    providerConversationId: row.providerConversationId,
    conversationSubject: row.conversationSubject,
    mailboxId: row.mailboxId,
    counterpartEmail: row.counterpartEmail,
    customerId: row.customerId,
    customerName: row.customerName,
    receivedAt: row.receivedAt.toISOString(),
    notePostedAt: row.notePostedAt?.toISOString() ?? null,
    noteLatencyMs: row.noteLatencyMs,
    noteBody: row.noteBody,
    draftExistedBeforeNote: row.draftExistedBeforeNote,
    ruleDraftCreatedAt: row.ruleDraftCreatedAt?.toISOString() ?? null,
    ruleDraftCheckedAt: row.ruleDraftCheckedAt?.toISOString() ?? null,
    hubDraftCreatedAt: row.hubDraftCreatedAt?.toISOString() ?? null,
    voiceProfileUsed: row.voiceProfileUsed,
    status: row.status,
    error: row.error,
    noteBeforeDraft: row.noteBeforeDraft,
    draftUsedNote: row.draftUsedNote,
    reviewNote: row.reviewNote,
    reviewedByEmail: row.reviewedByEmail,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

router.get("/ai-context/patterns/events", async (req, res): Promise<void> => {
  const parsed = ListDraftPatternEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const pattern =
    parsed.data.pattern === "B" || parsed.data.pattern === "C" ? parsed.data.pattern : undefined;
  const rows = await listPatternEvents(pattern, parsed.data.limit ?? 100);
  res.json(ListDraftPatternEventsResponse.parse(rows.map(eventDto)));
});

router.patch("/ai-context/patterns/events/:id", async (req, res): Promise<void> => {
  const params = ReviewDraftPatternEventParams.safeParse(req.params);
  const body = ReviewDraftPatternEventBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.success ? body : params).error?.message });
    return;
  }
  const [row] = await db
    .update(draftPatternEventsTable)
    .set({
      ...(body.data.noteBeforeDraft !== undefined
        ? { noteBeforeDraft: body.data.noteBeforeDraft }
        : {}),
      ...(body.data.draftUsedNote !== undefined
        ? { draftUsedNote: body.data.draftUsedNote }
        : {}),
      ...(body.data.reviewNote !== undefined ? { reviewNote: body.data.reviewNote } : {}),
      reviewedByEmail: req.staff?.email ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(draftPatternEventsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "event not found" });
    return;
  }
  res.json(ReviewDraftPatternEventResponse.parse(eventDto(row)));
});

/** Audit-log aggregates per pattern surface + Pattern B ordering stats. */
router.get("/ai-context/patterns/summary", async (req, res): Promise<void> => {
  const sinceDays = Number(req.query.sinceDays ?? 30);
  let since = new Date(Date.now() - (Number.isFinite(sinceDays) ? sinceDays : 30) * 86_400_000);
  let until: Date | undefined;
  if (req.query.start !== undefined || req.query.end !== undefined) {
    try {
      const range = easternCalendarRange(String(req.query.start), String(req.query.end));
      since = range.start; until = range.end;
    } catch { res.status(400).json({ error: "Invalid calendar date range" }); return; }
  }

  const auditRows = await db
    .select({
      surface: aiAuditEventsTable.surface,
      total: sql<number>`count(*)::int`,
      ok: sql<number>`(count(*) filter (where ${aiAuditEventsTable.ok}))::int`,
      scored: sql<number>`(count(*) filter (where ${aiAuditEventsTable.accuracy} is not null))::int`,
      correct: sql<number>`(count(*) filter (where ${aiAuditEventsTable.accuracy} = 'correct'))::int`,
      used: sql<number>`(count(*) filter (where ${aiAuditEventsTable.feedbackOutcome} in ('used','accepted')))::int`,
      edited: sql<number>`(count(*) filter (where ${aiAuditEventsTable.feedbackOutcome} = 'edited'))::int`,
      rejected: sql<number>`(count(*) filter (where ${aiAuditEventsTable.feedbackOutcome} in ('rejected','ignored')))::int`,
    })
    .from(aiAuditEventsTable)
    .where(
      and(
        gte(aiAuditEventsTable.createdAt, since),
        until ? sql`${aiAuditEventsTable.createdAt} < ${until}` : undefined,
        inArray(aiAuditEventsTable.surface, ["context_mcp", "context_rest", "pattern_b", "pattern_c"]),
      ),
    )
    .groupBy(aiAuditEventsTable.surface);

  const bySurface = new Map(auditRows.map((r) => [r.surface, r]));
  const zero = { total: 0, ok: 0, scored: 0, correct: 0, used: 0, edited: 0, rejected: 0 };
  const surfaceStats = (surface: string) => {
    const r = bySurface.get(surface) ?? { surface, ...zero };
    return {
      calls: r.total,
      okCalls: r.ok,
      scored: r.scored,
      correct: r.correct,
      usedOrAccepted: r.used,
      edited: r.edited,
      rejectedOrIgnored: r.rejected,
    };
  };

  const [bStats] = await db
    .select({
      events: sql<number>`count(*)::int`,
      notesPosted: sql<number>`(count(*) filter (where ${draftPatternEventsTable.notePostedAt} is not null))::int`,
      avgNoteLatencyMs: sql<number>`coalesce(avg(${draftPatternEventsTable.noteLatencyMs}), 0)::int`,
      maxNoteLatencyMs: sql<number>`coalesce(max(${draftPatternEventsTable.noteLatencyMs}), 0)::int`,
      orderingKnown: sql<number>`(count(*) filter (where ${draftPatternEventsTable.noteBeforeDraft} is not null))::int`,
      orderingHeld: sql<number>`(count(*) filter (where ${draftPatternEventsTable.noteBeforeDraft}))::int`,
      draftUsedNoteScored: sql<number>`(count(*) filter (where ${draftPatternEventsTable.draftUsedNote} is not null))::int`,
      draftUsedNoteYes: sql<number>`(count(*) filter (where ${draftPatternEventsTable.draftUsedNote}))::int`,
      errors: sql<number>`(count(*) filter (where ${draftPatternEventsTable.status} = 'error'))::int`,
    })
    .from(draftPatternEventsTable)
    .where(
      and(
        eq(draftPatternEventsTable.pattern, "B"),
        gte(draftPatternEventsTable.receivedAt, since),
        until ? sql`${draftPatternEventsTable.receivedAt} < ${until}` : undefined,
      ),
    );

  const [cStats] = await db
    .select({
      events: sql<number>`count(*)::int`,
      draftsCreated: sql<number>`(count(*) filter (where ${draftPatternEventsTable.hubDraftCreatedAt} is not null))::int`,
      errors: sql<number>`(count(*) filter (where ${draftPatternEventsTable.status} = 'error'))::int`,
    })
    .from(draftPatternEventsTable)
    .where(
      and(
        eq(draftPatternEventsTable.pattern, "C"),
        gte(draftPatternEventsTable.receivedAt, since),
        until ? sql`${draftPatternEventsTable.receivedAt} < ${until}` : undefined,
      ),
    );

  res.json(
    GetDraftPatternSummaryResponse.parse({
      sinceDays: until ? Math.round((until.valueOf() - since.valueOf()) / 86_400_000)
        : Number.isFinite(sinceDays) ? sinceDays : 30,
      patternA: surfaceStats("context_mcp"),
      patternB: {
        ...surfaceStats("pattern_b"),
        events: bStats?.events ?? 0,
        notesPosted: bStats?.notesPosted ?? 0,
        avgNoteLatencyMs: bStats?.avgNoteLatencyMs ?? 0,
        maxNoteLatencyMs: bStats?.maxNoteLatencyMs ?? 0,
        orderingKnown: bStats?.orderingKnown ?? 0,
        orderingHeld: bStats?.orderingHeld ?? 0,
        draftUsedNoteScored: bStats?.draftUsedNoteScored ?? 0,
        draftUsedNoteYes: bStats?.draftUsedNoteYes ?? 0,
        errors: bStats?.errors ?? 0,
      },
      patternC: {
        ...surfaceStats("pattern_c"),
        events: cStats?.events ?? 0,
        draftsCreated: cStats?.draftsCreated ?? 0,
        errors: cStats?.errors ?? 0,
      },
    }),
  );
});

export default router;
