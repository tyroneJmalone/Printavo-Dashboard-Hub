import { and, desc, eq, sql } from "drizzle-orm";
import { db, knowledgeEntriesTable } from "@workspace/db";

/**
 * Knowledge-base search for the context layer. Serves ONLY approved
 * entries whose effective window covers today. Source breadcrumbs
 * (source_name/source_url) are staff reference material and are never
 * returned through any door — the reviewed entry text is the canonical
 * fact (see the editorial rule on the schema).
 */
export async function searchKnowledge(input: {
  query: string;
  category?: string | null;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  const query = input.query.trim();
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const tsVector = sql`to_tsvector('english', coalesce(${knowledgeEntriesTable.title}, '') || ' ' || coalesce(${knowledgeEntriesTable.body}, ''))`;
  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  const conditions = [
    eq(knowledgeEntriesTable.reviewStatus, "approved"),
    sql`(${knowledgeEntriesTable.effectiveDate} IS NULL OR ${knowledgeEntriesTable.effectiveDate} <= CURRENT_DATE)`,
    sql`(${knowledgeEntriesTable.expiresDate} IS NULL OR ${knowledgeEntriesTable.expiresDate} >= CURRENT_DATE)`,
    sql`(${tsVector} @@ ${tsQuery}
      OR ${knowledgeEntriesTable.title} ILIKE ${like} ESCAPE '\\'
      OR ${knowledgeEntriesTable.body} ILIKE ${like} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM unnest(${knowledgeEntriesTable.tags}) tag WHERE tag ILIKE ${like} ESCAPE '\\'))`,
  ];
  if (input.category) {
    conditions.push(eq(knowledgeEntriesTable.category, input.category));
  }
  const rows = await db
    .select({
      id: knowledgeEntriesTable.id,
      title: knowledgeEntriesTable.title,
      body: knowledgeEntriesTable.body,
      category: knowledgeEntriesTable.category,
      tags: knowledgeEntriesTable.tags,
      effectiveDate: knowledgeEntriesTable.effectiveDate,
      updatedAt: knowledgeEntriesTable.updatedAt,
      rank: sql<number>`ts_rank(${tsVector}, ${tsQuery})`,
    })
    .from(knowledgeEntriesTable)
    .where(and(...conditions))
    .orderBy(desc(sql`ts_rank(${tsVector}, ${tsQuery})`), desc(knowledgeEntriesTable.updatedAt))
    .limit(limit);
  return {
    query,
    entries: rows.map((row) => ({
      id: row.id,
      title: row.title,
      // The reviewed entry text — quote it verbatim; do not paraphrase policies.
      body: row.body,
      category: row.category,
      tags: row.tags,
      effectiveDate: row.effectiveDate,
      lastUpdated: row.updatedAt.toISOString(),
    })),
    note:
      rows.length === 0
        ? "No approved knowledge entries matched. Answer only from other verified facts — do not guess company policy."
        : "Entries are staff-reviewed company facts. Quote 'body' text verbatim when stating policies, pricing rules, or promises.",
  };
}
