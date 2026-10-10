import { Router } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, knowledgeEntriesTable as entries, knowledgeEntrySourcesTable as links, type KnowledgeEntry } from "@workspace/db";
import {
  ListKnowledgeLibraryQueryParams,
  ListKnowledgeLibraryResponse,
  GetKnowledgeLibraryEntryParams,
  GetKnowledgeLibraryEntryResponse,
} from "@workspace/api-zod";
import { libraryEligibility, libraryFilters } from "../lib/knowledgeLibrary";
import { z } from "zod";

const router = Router();
const libraryQuery = ListKnowledgeLibraryQueryParams.extend({
  q: z.string().trim().max(200).optional(),
  category: z.string().max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

async function libraryDtos(rows: KnowledgeEntry[]) {
  const stale = rows.length ? await db.select({ id: links.entryId }).from(links)
    .where(and(inArray(links.entryId, rows.map(row => row.id)), eq(links.stale, "true"))) : [];
  const ids = new Set(stale.map(row => row.id));
  // Original source files are not approved articles. Do not expose raw document
  // links or bypass the existing admin-only source preview endpoint.
  return rows.map(row => GetKnowledgeLibraryEntryResponse.parse({
    ...row, sourceUrl: "", sourceStale: ids.has(row.id),
  }));
}

router.get("/knowledge/library", async (req, res) => {
  const parsed = libraryQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid library filters" });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  const { q, category, offset = 0 } = parsed.data;
  const where = libraryFilters(q, category);
  const [rows, totals, categories] = await Promise.all([
    db.select().from(entries).where(where)
      .orderBy(asc(entries.title), asc(entries.id)).limit(30).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(entries).where(where),
    db.select({ name: entries.category, count: sql<number>`count(*)::int` }).from(entries)
      .where(libraryEligibility()).groupBy(entries.category).orderBy(asc(entries.category)),
  ]);
  res.json(ListKnowledgeLibraryResponse.parse({
    items: await libraryDtos(rows), total: totals[0]?.count ?? 0, categories,
  }));
});

router.get("/knowledge/library/:id", async (req, res) => {
  const parsed = GetKnowledgeLibraryEntryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid resource ID" });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  const rows = await db.select().from(entries)
    .where(and(libraryEligibility(), eq(entries.id, parsed.data.id))).limit(1);
  if (!rows.length) {
    res.status(404).json({ error: "This resource is no longer available in the library." });
    return;
  }
  res.json((await libraryDtos(rows))[0]);
});

export default router;
