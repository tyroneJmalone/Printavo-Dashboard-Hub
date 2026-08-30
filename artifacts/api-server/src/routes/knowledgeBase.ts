import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, knowledgeEntriesTable, type KnowledgeEntry } from "@workspace/db";
import {
  CreateKnowledgeEntryBody,
  CreateKnowledgeEntryResponse,
  DeleteKnowledgeEntryParams,
  ListKnowledgeEntriesQueryParams,
  ListKnowledgeEntriesResponse,
  ReviewKnowledgeEntryBody,
  ReviewKnowledgeEntryParams,
  ReviewKnowledgeEntryResponse,
  UpdateKnowledgeEntryBody,
  UpdateKnowledgeEntryParams,
  UpdateKnowledgeEntryResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { shouldDemoteApprovedEntry } from "../lib/knowledgeEditorial";

/**
 * Staff CRUD + review workflow for the knowledge base that feeds the AI
 * context layer. Editorial rules:
 *  - new entries start as drafts; only approved entries are ever served
 *    to AI consumers (enforced in contextCore/knowledge.ts);
 *  - editing an approved entry demotes it back to draft (unless the
 *    editor cannot bypass this — there is no cosmetic-edit flag) so a
 *    changed fact always passes review again;
 *  - source material is reference only — the reviewed entry text is the
 *    canonical fact.
 */
const router: IRouter = Router();

function entryDto(row: KnowledgeEntry) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
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
  };
}

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
  res.json(ListKnowledgeEntriesResponse.parse(rows.map(entryDto)));
});

router.post("/knowledge/entries", async (req, res): Promise<void> => {
  const parsed = CreateKnowledgeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values({
      title: parsed.data.title,
      body: parsed.data.body,
      category: parsed.data.category ?? "general",
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
  const [existing] = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  const fields = parsed.data;
  // Every field AI consumers can see (or that affects retrieval) counts as
  // content and forces re-review; only staff-only source breadcrumbs are
  // exempt. No bypass flag exists — see lib/knowledgeEditorial.ts.
  const demote = shouldDemoteApprovedEntry(existing.reviewStatus, existing, fields);
  const [row] = await db
    .update(knowledgeEntriesTable)
    .set({
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      ...(fields.category !== undefined ? { category: fields.category } : {}),
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
  if (demote) {
    req.log.info({ entryId: row!.id }, "approved knowledge entry edited — demoted to draft");
  }
  res.json(UpdateKnowledgeEntryResponse.parse(entryDto(row!)));
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
  const [row] = await db
    .update(knowledgeEntriesTable)
    .set({ ...patch, updatedByEmail: req.staff!.email, updatedAt: now })
    .where(eq(knowledgeEntriesTable.id, params.data.id))
    .returning();
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
