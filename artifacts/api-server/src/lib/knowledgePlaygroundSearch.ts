import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, knowledgeEntriesTable } from "@workspace/db";
import {
  getKnowledgeClassificationSettings,
  type KnowledgeGroupId,
} from "./knowledgeClassification";
import type {
  KnowledgePlaygroundReviewStatus,
  KnowledgeSearchResult,
  PlaygroundKnowledgeSearchInput,
} from "./knowledgePlayground";

const PLAYGROUND_GROUPS = ["customer_shareable", "brand_voice"] as const;
type PlaygroundKnowledgeGroup = (typeof PLAYGROUND_GROUPS)[number];

function playgroundGroupRules(
  group: KnowledgeGroupId,
  settings: Awaited<ReturnType<typeof getKnowledgeClassificationSettings>>,
) {
  return settings.groups.find((candidate) => candidate.id === group);
}

function playgroundQueryCondition(query: string) {
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const tsVector = knowledgeEntriesTable.searchVector;
  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  return sql`(${tsVector} @@ ${tsQuery}
    OR ${knowledgeEntriesTable.title} ILIKE ${like} ESCAPE '\\'
    OR ${knowledgeEntriesTable.body} ILIKE ${like} ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM unnest(${knowledgeEntriesTable.tags}) tag WHERE tag ILIKE ${like} ESCAPE '\\'))`;
}

/**
 * Playground-only retrieval boundary.
 *
 * This deliberately does not call contextCore/knowledge.ts. Draft access is
 * available only through this staff test surface, and the group list is
 * closed so internal operational entries can never be selected by a caller.
 * Date predicates remain in force for both approved and draft rows.
 */
export async function searchPlaygroundKnowledge(
  input: PlaygroundKnowledgeSearchInput,
  group: PlaygroundKnowledgeGroup = "customer_shareable",
): Promise<KnowledgeSearchResult> {
  if (!PLAYGROUND_GROUPS.includes(group)) {
    throw new Error(`Unsupported knowledge playground group: ${group}`);
  }

  const query = input.query.trim();
  const includeDrafts = input.includeDrafts === true;
  const limit = Math.min(Math.max(input.limit || 1, 1), group === "brand_voice" ? 3 : 8);
  const settings = await getKnowledgeClassificationSettings();
  const classification = playgroundGroupRules(group, settings);
  if (!classification) {
    throw new Error(`Knowledge classification group is unavailable: ${group}`);
  }

  const conditions = [
    eq(knowledgeEntriesTable.knowledgeGroup, group),
    includeDrafts
      ? inArray(knowledgeEntriesTable.reviewStatus, ["approved", "draft"])
      : eq(knowledgeEntriesTable.reviewStatus, "approved"),
    sql`(${knowledgeEntriesTable.effectiveDate} IS NULL OR ${knowledgeEntriesTable.effectiveDate} <= CURRENT_DATE)`,
    sql`(${knowledgeEntriesTable.expiresDate} IS NULL OR ${knowledgeEntriesTable.expiresDate} >= CURRENT_DATE)`,
  ];
  if (query) conditions.push(playgroundQueryCondition(query));

  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const rows = await db
    .select({
      id: knowledgeEntriesTable.id,
      title: knowledgeEntriesTable.title,
      body: knowledgeEntriesTable.body,
      category: knowledgeEntriesTable.category,
      reviewStatus: knowledgeEntriesTable.reviewStatus,
      rank: sql<number>`ts_rank(${knowledgeEntriesTable.searchVector}, ${tsQuery})`,
      updatedAt: knowledgeEntriesTable.updatedAt,
    })
    .from(knowledgeEntriesTable)
    .where(and(...conditions))
    .orderBy(
      ...(query
        ? [desc(sql`ts_rank(${knowledgeEntriesTable.searchVector}, ${tsQuery})`)]
        : []),
      desc(knowledgeEntriesTable.updatedAt),
    )
    .limit(limit);

  const statusLabel = includeDrafts ? "approved or draft" : "approved";
  return {
    entries: rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      category: row.category,
      // This value is selected directly from the database and never inferred
      // from model output or the request's includeDrafts flag.
      reviewStatus: row.reviewStatus as KnowledgePlaygroundReviewStatus,
    })),
    rules: [...classification.rules],
    classificationUpdatedAt: settings.updatedAt,
    note:
      rows.length === 0
        ? `No ${statusLabel}, currently effective ${classification.label.toLocaleLowerCase()} entries matched.`
        : `Entries are ${statusLabel}, currently effective ${classification.label.toLocaleLowerCase()} context. ${
            group === "brand_voice"
              ? "Use brand guidance for tone only; never as factual evidence or citations."
              : "Use customer-shareable entries as factual context."
          }`,
  };
}

/** Explicit named wrapper prevents callers from selecting internal knowledge. */
export function searchPlaygroundBrandVoice(
  input: PlaygroundKnowledgeSearchInput,
): Promise<KnowledgeSearchResult> {
  return searchPlaygroundKnowledge(input, "brand_voice");
}