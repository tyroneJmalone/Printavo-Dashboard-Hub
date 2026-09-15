import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  knowledgeEntriesTable,
  knowledgeEntrySourcesTable,
  knowledgeSourceDocumentsTable,
  type KnowledgeEntry,
} from "@workspace/db";
import {
  BulkDeleteKnowledgeEntriesBody,
  BulkDeleteKnowledgeEntriesResponse,
  CommitKnowledgeMergeBody,
  CommitKnowledgeMergeResponse,
  CreateKnowledgeEntryBody,
  CreateKnowledgeEntryResponse,
  DeleteKnowledgeEntryParams,
  ListKnowledgeEntriesQueryParams,
  ListKnowledgeEntriesResponse,
  PreviewKnowledgeMergeBody,
  PreviewKnowledgeMergeResponse,
  ReviewKnowledgeEntryBody,
  ReviewKnowledgeEntryParams,
  ReviewKnowledgeEntryResponse,
  UpdateKnowledgeEntryBody,
  UpdateKnowledgeEntryParams,
  UpdateKnowledgeEntryResponse,
  GetKnowledgeClassificationSettingsResponse,
  UpdateKnowledgeClassificationSettingsBody,
  UpdateKnowledgeClassificationSettingsResponse,
  PlaygroundKnowledgeBody,
  PlaygroundKnowledgeResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { shouldDemoteApprovedEntry } from "../lib/knowledgeEditorial";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  KnowledgePlaygroundError,
  runKnowledgePlayground,
} from "../lib/knowledgePlayground";
import {
  searchPlaygroundBrandVoice,
  searchPlaygroundKnowledge,
} from "../lib/knowledgePlaygroundSearch";
import { checkRateLimit } from "../lib/aiGuardrails/rateLimit";
import {
  issueKnowledgeMergeToken,
  mergeLinksMatch,
  mergeSnapshotsMatch,
  takeKnowledgeMergeToken,
  type KnowledgeMergeLinkSnapshot,
} from "../lib/knowledgeMerge";
import {
  defaultKnowledgeGroupForCategory,
  getKnowledgeClassificationSettings,
  INTERNAL_KNOWLEDGE_GROUP,
  KnowledgeClassificationStaleError,
  KnowledgeClassificationValidationError,
  updateKnowledgeClassificationSettings,
  type KnowledgeGroupId,
} from "../lib/knowledgeClassification";
import { z } from "zod";

/**
 * Staff CRUD + review workflow for the knowledge base that feeds the AI
 * context layer. Editorial rules:
 *  - new entries start as drafts; live AI consumers receive only approved
 *    entries (enforced in contextCore/knowledge.ts). The staff-only
 *    playground has its own explicitly toggled retrieval boundary;
 *  - editing an approved entry demotes it back to draft (unless the
 *    editor cannot bypass this — there is no cosmetic-edit flag) so a
 *    changed fact always passes review again;
 *  - source material is reference only — the reviewed entry text is the
 *    canonical fact.
 */
const router: IRouter = Router();
const PLAYGROUND_RATE_LIMIT_PER_MINUTE = 12;
const playgroundInFlight = new Set<string>();
const MERGE_RATE_LIMIT_PER_MINUTE = 3;
const mergeInFlight = new Set<string>();
const mergeCandidateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(20_000),
  category: z.string().trim().min(1).max(50),
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  expiresDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
const mergeAiResponseSchema = z.object({
  candidate: mergeCandidateSchema,
  conflicts: z.array(z.string().trim().min(1).max(500)).max(20),
});

async function recomputeKnowledgeDocumentDraftCounts(
  tx: any,
  documentIds: string[],
  email: string,
): Promise<void> {
  for (const documentId of new Set(documentIds)) {
    const [{ count }] = await tx
      .select({
        count: sql<number>`count(distinct ${knowledgeEntrySourcesTable.entryId})`,
      })
      .from(knowledgeEntrySourcesTable)
      .innerJoin(
        knowledgeEntriesTable,
        eq(knowledgeEntriesTable.id, knowledgeEntrySourcesTable.entryId),
      )
      .where(
        and(
          eq(knowledgeEntrySourcesTable.documentId, documentId),
          eq(knowledgeEntriesTable.reviewStatus, "draft"),
        ),
      );
    await tx
      .update(knowledgeSourceDocumentsTable)
      .set({
        draftCount: Number(count ?? 0),
        updatedByEmail: email,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSourceDocumentsTable.id, documentId));
  }
}

function entryDto(row: KnowledgeEntry, sourceStale = false) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    knowledgeGroup: row.knowledgeGroup,
    tags: row.tags,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    effectiveDate: row.effectiveDate,
    expiresDate: row.expiresDate,
    reviewStatus: row.reviewStatus,
    approvedByEmail: row.approvedByEmail,
    approvedAt: row.approvedAt,
    lastReviewedAt: row.lastReviewedAt,
    createdByEmail: row.createdByEmail,
    updatedByEmail: row.updatedByEmail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sourceStale,
  };
}

function combinedSourceBreadcrumb(rows: KnowledgeEntry[]): { sourceName: string; sourceUrl: string } {
  const names = [...new Set(rows.map((row) => row.sourceName.trim()).filter(Boolean))];
  const urls = [...new Set(rows.map((row) => row.sourceUrl.trim()).filter(Boolean))];
  const sourceNameParts = names.length ? [...names] : ["selected knowledge entries"];
  let sourceUrl = "";
  const commonUrl = urls.length === 1 ? urls[0]! : undefined;
  const usableCommonUrl =
    commonUrl &&
    commonUrl.length <= 1_000 &&
    !/[\r\n]/.test(commonUrl) &&
    (() => {
      try {
        new URL(commonUrl);
        return true;
      } catch {
        return false;
      }
    })();
  if (usableCommonUrl) {
    sourceUrl = commonUrl;
  } else if (urls.length > 0) {
    // sourceUrl is a single-link editor field. Keep every distinct URL in
    // the staff-only breadcrumb instead of writing a newline-delimited value
    // that is not a usable URL and cannot be edited safely.
    sourceNameParts.push(`URLs: ${urls.join(" | ")}`);
  }
  const sourceName = `Merged source breadcrumbs: ${sourceNameParts.join(" | ")}`;
  if (sourceName.length > 300) {
    throw new KnowledgeMergeProvenanceError(
      "The preserved source breadcrumbs exceed the 300-character source name limit; shorten the source metadata or merge fewer entries.",
    );
  }
  return {
    sourceName,
    sourceUrl,
  };
}

class KnowledgeMergeProvenanceError extends Error {
  readonly code = "merge_provenance_too_large";
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeMergeProvenanceError";
  }
}

router.post("/knowledge/playground", async (req, res): Promise<void> => {
  const parsed = PlaygroundKnowledgeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const staffKey = `knowledge-playground:${req.staff!.id}`;
  const rate = checkRateLimit(staffKey, PLAYGROUND_RATE_LIMIT_PER_MINUTE);
  if (!rate.allowed) {
    res
      .status(429)
      .set("Retry-After", String(rate.retryAfterSeconds))
      .json({ error: "Knowledge playground rate limit reached. Try again shortly." });
    return;
  }
  if (playgroundInFlight.has(staffKey)) {
    res
      .status(429)
      .set("Retry-After", "1")
      .json({ error: "A knowledge playground request is already in progress." });
    return;
  }
  playgroundInFlight.add(staffKey);

  try {
    const result = await runKnowledgePlayground(parsed.data, {
      // This route owns the only draft-capable retriever. The live context
      // search remains a separate approved-only boundary.
      searchKnowledge: ({ query, limit, includeDrafts }) =>
        searchPlaygroundKnowledge({ query, limit, includeDrafts }),
      searchPlaygroundKnowledge: ({ query, limit, includeDrafts }) =>
        searchPlaygroundKnowledge({ query, limit, includeDrafts }),
      searchPlaygroundBrandVoice: ({ query, limit, includeDrafts }) =>
        searchPlaygroundBrandVoice({ query, limit, includeDrafts }),
      createChatCompletion: (request, options) =>
        openai.chat.completions.create(request, options),
    });
    res.json(PlaygroundKnowledgeResponse.parse(result));
  } catch (error) {
    if (error instanceof KnowledgePlaygroundError) {
      req.log.error({ err: error, stage: error.stage }, "knowledge playground failed");
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "knowledge playground failed");
    res.status(503).json({ error: "Knowledge playground is temporarily unavailable." });
  } finally {
    playgroundInFlight.delete(staffKey);
  }
});

router.get("/knowledge/entries", async (req, res): Promise<void> => {
  const query = ListKnowledgeEntriesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions = [];
  if (query.data.status) {
    conditions.push(eq(knowledgeEntriesTable.reviewStatus, query.data.status));
  }
  if (query.data.category) {
    conditions.push(eq(knowledgeEntriesTable.category, query.data.category));
  }
  if (query.data.knowledgeGroup) {
    conditions.push(eq(knowledgeEntriesTable.knowledgeGroup, query.data.knowledgeGroup));
  }
  if (query.data.q) {
    const like = `%${query.data.q.replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(
      sql`(${knowledgeEntriesTable.title} ILIKE ${like} ESCAPE '\\' OR ${knowledgeEntriesTable.body} ILIKE ${like} ESCAPE '\\')`,
    );
  }
  const rows = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(knowledgeEntriesTable.updatedAt))
    .limit(500);
  const staleLinks = rows.length
    ? await db
        .select({ entryId: knowledgeEntrySourcesTable.entryId })
        .from(knowledgeEntrySourcesTable)
        .where(
          and(
            inArray(knowledgeEntrySourcesTable.entryId, rows.map((row) => row.id)),
            eq(knowledgeEntrySourcesTable.stale, "true"),
          ),
        )
    : [];
  const staleIds = new Set(staleLinks.map((link) => link.entryId));
  res.json(ListKnowledgeEntriesResponse.parse(rows.map((row) => entryDto(row, staleIds.has(row.id)))));
});

router.get("/knowledge/classification-settings", async (_req, res): Promise<void> => {
  const settings = await getKnowledgeClassificationSettings();
  res.json(GetKnowledgeClassificationSettingsResponse.parse(settings));
});

router.put(
  "/knowledge/classification-settings",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = UpdateKnowledgeClassificationSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const settings = await updateKnowledgeClassificationSettings(
        parsed.data.groups,
        parsed.data.updatedAt,
      );
      res.json(UpdateKnowledgeClassificationSettingsResponse.parse(settings));
    } catch (error) {
      if (error instanceof KnowledgeClassificationStaleError) {
        res.status(409).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof KnowledgeClassificationValidationError) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/knowledge/entries/bulk-delete",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = BulkDeleteKnowledgeEntriesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const entryIds = parsed.data.entryIds;
    if (new Set(entryIds).size !== entryIds.length) {
      res.status(400).json({ error: "Entry ids must be unique" });
      return;
    }
    if (
      parsed.data.snapshots.length !== entryIds.length ||
      new Set(parsed.data.snapshots.map((snapshot) => snapshot.id)).size !== entryIds.length ||
      parsed.data.snapshots.some((snapshot) => !entryIds.includes(snapshot.id))
    ) {
      res.status(400).json({ error: "Every selected entry must include exactly one current snapshot" });
      return;
    }

    const selectedRows = await db
      .select({
        id: knowledgeEntriesTable.id,
        reviewStatus: knowledgeEntriesTable.reviewStatus,
        knowledgeGroup: knowledgeEntriesTable.knowledgeGroup,
        updatedAt: knowledgeEntriesTable.updatedAt,
      })
      .from(knowledgeEntriesTable)
      .where(inArray(knowledgeEntriesTable.id, entryIds));
    if (selectedRows.length !== entryIds.length) {
      res.status(409).json({
        error: "One or more selected entries no longer exist; nothing was deleted.",
        code: "stale_selection",
      });
      return;
    }
    const counts = {
      selectedCount: selectedRows.length,
      approvedCount: selectedRows.filter((row) => row.reviewStatus === "approved").length,
      draftCount: selectedRows.filter((row) => row.reviewStatus === "draft").length,
      archivedCount: selectedRows.filter((row) => row.reviewStatus === "archived").length,
    };
    if (!parsed.data.confirm) {
      res.status(400).json({
        error: "Explicit confirmation is required before permanently deleting knowledge entries.",
        code: "confirmation_required",
        ...counts,
      });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const locked = await tx
          .select({
            id: knowledgeEntriesTable.id,
            reviewStatus: knowledgeEntriesTable.reviewStatus,
            knowledgeGroup: knowledgeEntriesTable.knowledgeGroup,
            updatedAt: knowledgeEntriesTable.updatedAt,
          })
          .from(knowledgeEntriesTable)
          .where(inArray(knowledgeEntriesTable.id, entryIds))
          .orderBy(asc(knowledgeEntriesTable.id))
          .for("update");
        if (locked.length !== entryIds.length) {
          throw new Error("stale_selection");
        }
        const snapshots = new Map(parsed.data.snapshots.map((snapshot) => [snapshot.id, snapshot]));
        if (locked.some((row) => {
          const snapshot = snapshots.get(row.id);
          return (
            !snapshot ||
            row.updatedAt.toISOString() !== snapshot.updatedAt.toISOString() ||
            row.reviewStatus !== snapshot.reviewStatus ||
            (snapshot.knowledgeGroup !== undefined &&
              row.knowledgeGroup !== snapshot.knowledgeGroup)
          );
        })) {
          throw new Error("stale_selection");
        }
        const affectedLinks = await tx
          .select({ documentId: knowledgeEntrySourcesTable.documentId })
          .from(knowledgeEntrySourcesTable)
          .where(inArray(knowledgeEntrySourcesTable.entryId, entryIds))
          .orderBy(
            asc(knowledgeEntrySourcesTable.entryId),
            asc(knowledgeEntrySourcesTable.documentId),
            asc(knowledgeEntrySourcesTable.sectionKey),
          )
          .for("update");
        const affectedDocumentIds = [...new Set(affectedLinks.map((link) => link.documentId))];
        if (affectedDocumentIds.length) {
          await tx
            .select({ id: knowledgeSourceDocumentsTable.id })
            .from(knowledgeSourceDocumentsTable)
            .where(inArray(knowledgeSourceDocumentsTable.id, affectedDocumentIds))
            .orderBy(asc(knowledgeSourceDocumentsTable.id))
            .for("update");
        }
        const deleted = await tx
          .delete(knowledgeEntriesTable)
          .where(inArray(knowledgeEntriesTable.id, entryIds))
          .returning({ id: knowledgeEntriesTable.id });
        if (deleted.length !== entryIds.length) {
          throw new Error("stale_selection");
        }
        await recomputeKnowledgeDocumentDraftCounts(tx, affectedDocumentIds, req.staff!.email);
        return {
          selectedCount: locked.length,
          approvedCount: locked.filter((row) => row.reviewStatus === "approved").length,
          draftCount: locked.filter((row) => row.reviewStatus === "draft").length,
          archivedCount: locked.filter((row) => row.reviewStatus === "archived").length,
        };
      });
      req.log.info({ entryIds, by: req.staff!.email, ...result }, "knowledge entries bulk deleted");
      res.json(BulkDeleteKnowledgeEntriesResponse.parse(result));
    } catch (error) {
      if (error instanceof Error && error.message === "stale_selection") {
        res.status(409).json({
          error: "The selection changed while deleting; nothing was deleted.",
          code: "stale_selection",
        });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/knowledge/entries/merge/preview",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = PreviewKnowledgeMergeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const entryIds = parsed.data.entryIds;
    if (new Set(entryIds).size !== entryIds.length) {
      res.status(400).json({ error: "Entry ids must be unique" });
      return;
    }
    const staffKey = `knowledge-merge:${req.staff!.id}`;
    const rate = checkRateLimit(staffKey, MERGE_RATE_LIMIT_PER_MINUTE);
    if (!rate.allowed) {
      res
        .status(429)
        .set("Retry-After", String(rate.retryAfterSeconds))
        .json({ error: "Knowledge merge rate limit reached. Try again shortly." });
      return;
    }
    if (mergeInFlight.has(staffKey)) {
      res
        .status(429)
        .set("Retry-After", "1")
        .json({ error: "A knowledge merge request is already in progress." });
      return;
    }
    mergeInFlight.add(staffKey);

    try {
      const rows = await db
        .select()
        .from(knowledgeEntriesTable)
        .where(inArray(knowledgeEntriesTable.id, entryIds));
      if (rows.length !== entryIds.length) {
        res.status(409).json({
          error: "One or more selected entries no longer exist; refresh and select them again.",
          code: "stale_selection",
        });
        return;
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      const orderedRows = entryIds.map((id) => byId.get(id)!);
      const originalKnowledgeGroups = new Set(
        orderedRows.map((row) => row.knowledgeGroup),
      );
      const mergeKnowledgeGroup: KnowledgeGroupId =
        originalKnowledgeGroups.size === 1
          ? orderedRows[0]!.knowledgeGroup as KnowledgeGroupId
          : INTERNAL_KNOWLEDGE_GROUP;
      const sourceLinks = await db
        .select({
          entryId: knowledgeEntrySourcesTable.entryId,
          documentId: knowledgeEntrySourcesTable.documentId,
          sectionKey: knowledgeEntrySourcesTable.sectionKey,
          stale: knowledgeEntrySourcesTable.stale,
          createdAt: knowledgeEntrySourcesTable.createdAt,
        })
        .from(knowledgeEntrySourcesTable)
        .where(inArray(knowledgeEntrySourcesTable.entryId, entryIds));
      const staleIds = new Set(
        sourceLinks
          .filter((link) => link.stale === "true")
          .map((link) => link.entryId),
      );
      const linkSnapshots: KnowledgeMergeLinkSnapshot[] = sourceLinks.map((link) => ({
        entryId: link.entryId,
        documentId: link.documentId,
        sectionKey: link.sectionKey,
        stale: link.stale,
        createdAt: link.createdAt.toISOString(),
      }));
      // Keep the AI input deliberately narrower than the staff editor DTO.
      // Source breadcrumbs and every audit field are staff-only and must never
      // be sent to an external model.
      const aiEntries = orderedRows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        category: row.category,
        tags: row.tags,
        knowledgeGroup: row.knowledgeGroup,
        effectiveDate: row.effectiveDate,
        expiresDate: row.expiresDate,
      }));

      const completion = await openai.chat.completions.create({
        model: "gpt-5.6-terra",
        messages: [
          {
            role: "system",
            content:
              "Consolidate the supplied company knowledge entries into one coherent human-review draft. Use only facts explicitly present in the entries: never invent, infer, or silently choose between incompatible values. Preserve every qualification, exception, condition, date window, and operational detail. If entries conflict, preserve both positions in the body and explicitly describe each conflict in the conflicts array; the body should include a clearly labeled 'Conflicts requiring review' section. Return JSON only with {candidate:{title,body,category,tags,effectiveDate,expiresDate},conflicts:[string]}. The result is always a draft and must not imply approval. Dates are YYYY-MM-DD only when explicitly stated, otherwise null.",
          },
          {
            role: "user",
            content: JSON.stringify({ entries: aiEntries }),
          },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 12_000,
      });
      const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as unknown;
      const aiResult = mergeAiResponseSchema.safeParse(raw);
      if (!aiResult.success) {
        throw new Error(`AI knowledge merge returned invalid data: ${aiResult.error.message}`);
      }
      const conflicts = Array.from(new Set(aiResult.data.conflicts));
      let candidate = aiResult.data.candidate;
      if (conflicts.length > 0 && !/\bconflicts requiring review\b/i.test(candidate.body)) {
        candidate = {
          ...candidate,
          body: `${candidate.body}\n\nConflicts requiring review:\n${conflicts.map((conflict) => `- ${conflict}`).join("\n")}`,
        };
      }
      const response = {
        token: issueKnowledgeMergeToken(
          req.staff!.id,
          orderedRows.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt.toISOString(),
            knowledgeGroup: row.knowledgeGroup,
          })),
          linkSnapshots,
        ),
        entryIds,
        entries: orderedRows.map((row) => entryDto(row, staleIds.has(row.id))),
        candidate: { ...candidate, knowledgeGroup: mergeKnowledgeGroup },
        conflicts,
      };
      res.json(PreviewKnowledgeMergeResponse.parse(response));
    } catch (error) {
      req.log.error({ err: error }, "knowledge merge preview failed");
      res.status(503).json({ error: "Knowledge merge is temporarily unavailable." });
    } finally {
      mergeInFlight.delete(staffKey);
    }
  },
);

router.post(
  "/knowledge/entries/merge/commit",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = CommitKnowledgeMergeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const entryIds = parsed.data.entryIds;
    if (new Set(entryIds).size !== entryIds.length) {
      res.status(400).json({ error: "Entry ids must be unique" });
      return;
    }
    const staffKey = `knowledge-merge:${req.staff!.id}`;
    if (mergeInFlight.has(staffKey)) {
      res
        .status(429)
        .set("Retry-After", "1")
        .json({ error: "A knowledge merge request is already in progress." });
      return;
    }
    mergeInFlight.add(staffKey);
    const expected = takeKnowledgeMergeToken(parsed.data.token, req.staff!.id, entryIds);
    if (!expected) {
      mergeInFlight.delete(staffKey);
      res.status(409).json({
        error: "This merge preview is expired, already used, or belongs to a different selection. Generate a new preview.",
        code: "stale_preview",
      });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const lockedRows = await tx
          .select()
          .from(knowledgeEntriesTable)
          .where(inArray(knowledgeEntriesTable.id, entryIds))
          .orderBy(asc(knowledgeEntriesTable.id))
          .for("update");
        const actual = lockedRows.map((row) => ({
          id: row.id,
          updatedAt: row.updatedAt.toISOString(),
          knowledgeGroup: row.knowledgeGroup,
        }));
        if (lockedRows.length !== entryIds.length || !mergeSnapshotsMatch(expected.snapshots, actual)) {
          throw new Error("stale_preview");
        }

        const links = await tx
          .select({
            entryId: knowledgeEntrySourcesTable.entryId,
            documentId: knowledgeEntrySourcesTable.documentId,
            sectionKey: knowledgeEntrySourcesTable.sectionKey,
            stale: knowledgeEntrySourcesTable.stale,
            createdAt: knowledgeEntrySourcesTable.createdAt,
          })
          .from(knowledgeEntrySourcesTable)
          .where(inArray(knowledgeEntrySourcesTable.entryId, entryIds))
          .orderBy(
            asc(knowledgeEntrySourcesTable.entryId),
            asc(knowledgeEntrySourcesTable.documentId),
            asc(knowledgeEntrySourcesTable.sectionKey),
          )
          .for("update");
        const actualLinks: KnowledgeMergeLinkSnapshot[] = links.map((link) => ({
          entryId: link.entryId,
          documentId: link.documentId,
          sectionKey: link.sectionKey,
          stale: link.stale,
          createdAt: link.createdAt.toISOString(),
        }));
        if (!mergeLinksMatch(expected.links, actualLinks)) {
          throw new Error("stale_preview");
        }
        const affectedDocumentIds = [...new Set(links.map((link) => link.documentId))];
        if (affectedDocumentIds.length) {
          await tx
            .select({ id: knowledgeSourceDocumentsTable.id })
            .from(knowledgeSourceDocumentsTable)
            .where(inArray(knowledgeSourceDocumentsTable.id, affectedDocumentIds))
            .orderBy(asc(knowledgeSourceDocumentsTable.id))
            .for("update");
        }
        const uniqueLinks = new Map<string, { documentId: string; sectionKey: string; stale: string }>();
        for (const link of links) {
          const key = `${link.documentId}:${link.sectionKey}`;
          const current = uniqueLinks.get(key);
          uniqueLinks.set(key, {
            ...link,
            stale: current?.stale === "true" || link.stale === "true" ? "true" : "false",
          });
        }

        const [merged] = await tx
          .insert(knowledgeEntriesTable)
          .values({
            title: parsed.data.candidate.title,
            body: parsed.data.candidate.body,
            category: parsed.data.candidate.category,
            knowledgeGroup:
              parsed.data.candidate.knowledgeGroup ??
              (new Set(lockedRows.map((row) => row.knowledgeGroup)).size === 1
                ? (lockedRows[0]!.knowledgeGroup as KnowledgeGroupId)
                : INTERNAL_KNOWLEDGE_GROUP),
            tags: parsed.data.candidate.tags,
            effectiveDate: parsed.data.candidate.effectiveDate,
            expiresDate: parsed.data.candidate.expiresDate,
            ...combinedSourceBreadcrumb(lockedRows),
            reviewStatus: "draft",
            approvedByEmail: null,
            approvedAt: null,
            lastReviewedAt: null,
            createdByEmail: req.staff!.email,
            updatedByEmail: req.staff!.email,
          })
          .returning();
        if (!merged) throw new Error("merge_insert_failed");

        if (uniqueLinks.size > 0) {
          await tx
            .insert(knowledgeEntrySourcesTable)
            .values(
              [...uniqueLinks.values()].map((link) => ({
                entryId: merged.id,
                documentId: link.documentId,
                sectionKey: link.sectionKey,
                stale: link.stale,
              })),
            )
            .onConflictDoNothing();
        }
        const deleted = await tx
          .delete(knowledgeEntriesTable)
          .where(inArray(knowledgeEntriesTable.id, entryIds))
          .returning({ id: knowledgeEntriesTable.id });
        if (deleted.length !== entryIds.length) {
          throw new Error("stale_preview");
        }
        await recomputeKnowledgeDocumentDraftCounts(tx, affectedDocumentIds, req.staff!.email);
        return {
          entry: entryDto(merged, [...uniqueLinks.values()].some((link) => link.stale === "true")),
          deletedEntryIds: entryIds,
          sourceLinkCount: uniqueLinks.size,
        };
      });
      req.log.info(
        { entryIds, mergedEntryId: result.entry.id, by: req.staff!.email },
        "knowledge entries merged",
      );
      res.json(CommitKnowledgeMergeResponse.parse(result));
    } catch (error) {
      if (error instanceof KnowledgeMergeProvenanceError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof Error && error.message === "stale_preview") {
        res.status(409).json({
          error: "A selected entry changed or disappeared while this merge was open. Nothing was changed; generate a new preview.",
          code: "stale_preview",
        });
        return;
      }
      req.log.error({ err: error }, "knowledge merge commit failed");
      res.status(503).json({ error: "Knowledge merge could not be saved. Nothing was changed." });
    } finally {
      mergeInFlight.delete(staffKey);
    }
  },
);

router.post("/knowledge/entries", async (req, res): Promise<void> => {
  const parsed = CreateKnowledgeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const category = parsed.data.category ?? "general";
  const classificationSettings = await getKnowledgeClassificationSettings();
  const knowledgeGroup =
    parsed.data.knowledgeGroup ??
    defaultKnowledgeGroupForCategory(category, classificationSettings);
  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values({
      title: parsed.data.title,
      body: parsed.data.body,
      category,
      knowledgeGroup,
      tags: parsed.data.tags ?? [],
      sourceName: parsed.data.sourceName ?? "",
      sourceUrl: parsed.data.sourceUrl ?? "",
      effectiveDate: parsed.data.effectiveDate ?? null,
      expiresDate: parsed.data.expiresDate ?? null,
      reviewStatus: "draft",
      createdByEmail: req.staff!.email,
      updatedByEmail: req.staff!.email,
    })
    .returning();
  req.log.info({ entryId: row!.id }, "knowledge entry created");
  res.status(201).json(CreateKnowledgeEntryResponse.parse(entryDto(row!)));
});

router.patch("/knowledge/entries/:id", async (req, res): Promise<void> => {
  const params = UpdateKnowledgeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateKnowledgeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const fields = parsed.data;
  // Lock before reading reviewStatus or visible fields. Approval uses the same
  // row lock below, so an edit either observes the approval and demotes or is
  // committed first and can then be approved as the latest content.
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, params.data.id))
      .for("update");
    if (!existing) return null;

    // Every field AI consumers can see (or that affects retrieval) counts as
    // content and forces re-review; only staff-only source breadcrumbs are
    // exempt. No bypass flag exists — see lib/knowledgeEditorial.ts.
    const demote = shouldDemoteApprovedEntry(existing.reviewStatus, existing, fields);
    const [row] = await tx
      .update(knowledgeEntriesTable)
      .set({
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.category !== undefined ? { category: fields.category } : {}),
        ...(fields.knowledgeGroup !== undefined
          ? { knowledgeGroup: fields.knowledgeGroup }
          : {}),
        ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
        ...(fields.sourceName !== undefined ? { sourceName: fields.sourceName } : {}),
        ...(fields.sourceUrl !== undefined ? { sourceUrl: fields.sourceUrl } : {}),
        ...(fields.effectiveDate !== undefined ? { effectiveDate: fields.effectiveDate } : {}),
        ...(fields.expiresDate !== undefined ? { expiresDate: fields.expiresDate } : {}),
        ...(demote ? { reviewStatus: "draft" } : {}),
        updatedByEmail: req.staff!.email,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeEntriesTable.id, params.data.id))
      .returning();
    return { row, demote };
  });
  if (!result?.row) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  const { row, demote } = result;
  if (demote) {
    req.log.info({ entryId: row.id }, "approved knowledge entry edited — demoted to draft");
  }
  res.json(UpdateKnowledgeEntryResponse.parse(entryDto(row)));
});

router.post("/knowledge/entries/:id/review", async (req, res): Promise<void> => {
  const params = ReviewKnowledgeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = ReviewKnowledgeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const now = new Date();
  const patch =
    parsed.data.action === "approve"
      ? {
          reviewStatus: "approved",
          approvedByEmail: req.staff!.email,
          approvedAt: now,
          lastReviewedAt: now,
        }
      : parsed.data.action === "archive"
        ? { reviewStatus: "archived", lastReviewedAt: now }
        : { reviewStatus: "draft", lastReviewedAt: now };
  // Match PATCH's lock ordering. If an edit wins first, this approval applies
  // to the edited content; if approval wins first, PATCH observes approved and
  // demotes its subsequent visible edit.
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: knowledgeEntriesTable.id })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, params.data.id))
      .for("update");
    if (!existing) return null;
    const [updated] = await tx
      .update(knowledgeEntriesTable)
      .set({ ...patch, updatedByEmail: req.staff!.email, updatedAt: now })
      .where(eq(knowledgeEntriesTable.id, params.data.id))
      .returning();
    return updated ?? null;
  });
  if (!row) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  req.log.info(
    { entryId: row.id, action: parsed.data.action, by: req.staff!.email },
    "knowledge entry reviewed",
  );
  res.json(ReviewKnowledgeEntryResponse.parse(entryDto(row)));
});

router.delete(
  "/knowledge/entries/:id",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = DeleteKnowledgeEntryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [row] = await db
      .delete(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, params.data.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    req.log.info({ entryId: row.id, by: req.staff!.email }, "knowledge entry deleted");
    res.sendStatus(204);
  },
);

export default router;
