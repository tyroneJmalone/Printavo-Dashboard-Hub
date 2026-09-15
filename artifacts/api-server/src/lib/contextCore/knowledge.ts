import { and, desc, eq, sql } from "drizzle-orm";
import { db, knowledgeEntriesTable } from "@workspace/db";
import {
  getKnowledgeClassificationSettings,
  type KnowledgeClassificationSettings,
  type KnowledgeGroupId,
} from "../knowledgeClassification";

export interface KnowledgeSearchEntry {
  id: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  effectiveDate: string | null;
  lastUpdated: string;
  /**
   * This is present only on staff-only responses. Customer search deliberately
   * omits classification metadata so a caller cannot mistake a different
   * group for a customer fact.
   */
  knowledgeGroup?: KnowledgeGroupId;
}

export interface KnowledgeSearchResult {
  query: string;
  entries: KnowledgeSearchEntry[];
  rules: string[];
  classificationUpdatedAt: string | null;
  note: string;
}

export interface KnowledgeSearchInput {
  query: string;
  category?: string | null;
  limit?: number;
}

/**
 * Internal-only policy injection for deterministic tests. Context tools never
 * accept this argument, so an untrusted model cannot choose a classification
 * policy or audience.
 */
export interface KnowledgeSearchOptions {
  classificationSettings?: KnowledgeClassificationSettings;
}

/** The schema's explicit classification boundary; never infer it from category. */
function knowledgeGroupColumn() {
  return knowledgeEntriesTable.knowledgeGroup;
}

async function classificationGroup(
  id: KnowledgeGroupId,
  override?: KnowledgeClassificationSettings,
) {
  const settings = override ?? (await getKnowledgeClassificationSettings());
  const group = settings.groups.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`Knowledge classification group is unavailable: ${id}`);
  return { settings, group };
}

async function currentAndApprovedConditions(
  group: KnowledgeGroupId,
  classificationSettings?: KnowledgeClassificationSettings,
): Promise<ReturnType<typeof sql>[]> {
  const { group: classification } = await classificationGroup(group, classificationSettings);
  // The categories are policy metadata for editors and prompt rules. Group
  // isolation is always enforced by knowledge_group, never by an untrusted
  // category supplied by a model.
  void classification;
  const knowledgeGroup = knowledgeGroupColumn();
  return [
    eq(knowledgeEntriesTable.reviewStatus, "approved"),
    sql`(${knowledgeEntriesTable.effectiveDate} IS NULL OR ${knowledgeEntriesTable.effectiveDate} <= CURRENT_DATE)`,
    sql`(${knowledgeEntriesTable.expiresDate} IS NULL OR ${knowledgeEntriesTable.expiresDate} >= CURRENT_DATE)`,
    sql`${knowledgeGroup} = ${group}`,
  ];
}

function queryCondition(query: string): ReturnType<typeof sql> {
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const tsVector = knowledgeEntriesTable.searchVector;
  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  return sql`(${tsVector} @@ ${tsQuery}
    OR ${knowledgeEntriesTable.title} ILIKE ${like} ESCAPE '\\'
    OR ${knowledgeEntriesTable.body} ILIKE ${like} ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM unnest(${knowledgeEntriesTable.tags}) tag WHERE tag ILIKE ${like} ESCAPE '\\'))`;
}

async function searchKnowledgeGroup(
  input: KnowledgeSearchInput,
  group: KnowledgeGroupId,
  options: { includeGroup: boolean; note: string; allowEmptyQuery?: boolean },
  classificationSettings?: KnowledgeClassificationSettings,
): Promise<KnowledgeSearchResult> {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), options.includeGroup ? 12 : 20);
  const query = input.query.trim();
  if (!query && !options.allowEmptyQuery) {
    return await emptySearchResult(query, group, options.note, classificationSettings);
  }
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const tsVector = knowledgeEntriesTable.searchVector;
  const conditions = [
    ...(await currentAndApprovedConditions(group, classificationSettings)),
  ];
  if (query) conditions.push(queryCondition(query));
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

  const { settings, group: classification } = await classificationGroup(group, classificationSettings);
  return {
    query,
    entries: rows.map((row) => ({
      id: row.id,
      title: row.title,
      // Reviewed body text is the canonical fact. Source breadcrumbs are
      // intentionally not selected and can never cross a consumer boundary.
      body: row.body,
      category: row.category,
      tags: row.tags,
      effectiveDate: row.effectiveDate,
      lastUpdated: row.updatedAt.toISOString(),
      ...(options.includeGroup ? { knowledgeGroup: classification.id } : {}),
    })),
    rules: [...classification.rules],
    classificationUpdatedAt: settings.updatedAt,
    note:
      rows.length === 0
        ? `No approved, currently effective ${classification.label.toLocaleLowerCase()} entries matched.`
        : options.note,
  };
}

async function emptySearchResult(
  query: string,
  group: KnowledgeGroupId,
  note: string,
  classificationSettings?: KnowledgeClassificationSettings,
): Promise<KnowledgeSearchResult> {
  const { settings, group: classification } = await classificationGroup(group, classificationSettings);
  return {
    query,
    entries: [],
    rules: [...classification.rules],
    classificationUpdatedAt: settings.updatedAt,
    note: `No approved, currently effective ${classification.label.toLocaleLowerCase()} entries matched. ${note}`,
  };
}

/**
 * Customer-facing knowledge search. This boundary is intentionally
 * classification-fixed: category is only a filter within customer-shareable
 * facts and cannot select another audience, even for an internal caller.
 */
export async function searchKnowledge(
  input: KnowledgeSearchInput,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult> {
  if (!input.query.trim()) {
    return emptySearchResult(
      "",
      "customer_shareable",
      "Entries are approved customer-shareable company facts. Quote body text verbatim for factual claims.",
      options.classificationSettings,
    );
  }
  return searchKnowledgeGroup(input, "customer_shareable", {
    includeGroup: false,
    note: "Entries are approved customer-shareable company facts. Quote body text verbatim for factual claims.",
  }, options.classificationSettings);
}

/**
 * Staff-only operational knowledge. This is not an alternate audience flag
 * for searchKnowledge; it is a separate function and a separate tool with a
 * separate trust-tier boundary.
 */
export async function searchInternalKnowledge(
  input: KnowledgeSearchInput,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult> {
  return searchKnowledgeGroup(input, "internal_operational", {
    includeGroup: true,
    note: "Entries are approved staff-only operational context. Never disclose them to customers or use them as customer-facing citations.",
  }, options.classificationSettings);
}

/**
 * Brand voice is retrieved separately from facts. Callers should put the
 * returned bodies in a tone-only prompt section and never cite these entries
 * as evidence for factual claims.
 */
export async function searchBrandVoiceGuidance(
  input: KnowledgeSearchInput,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult> {
  return searchKnowledgeGroup(
    { ...input, limit: Math.min(input.limit ?? 3, 3) },
    "brand_voice",
    {
      includeGroup: true,
      allowEmptyQuery: true,
      note: "Entries are approved brand-voice guidance only. Use for tone and style; never use as factual evidence or citations.",
    },
    options.classificationSettings,
  );
}

export async function knowledgeRules(
  group: KnowledgeGroupId,
  classificationSettings?: KnowledgeClassificationSettings,
): Promise<{
  rules: string[];
  updatedAt: string | null;
}> {
  const { settings, group: classification } = await classificationGroup(group, classificationSettings);
  return { rules: [...classification.rules], updatedAt: settings.updatedAt };
}

/**
 * Attach the brand lookup to the default search function without changing the
 * route-level playground dependency contract. The playground only uses this
 * property when the real search function is supplied; unit-test fakes do not
 * accidentally touch the database.
 */
Object.assign(searchKnowledge, { searchBrandVoiceGuidance });
