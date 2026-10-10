import { and, eq, sql } from "drizzle-orm";
import { knowledgeEntriesTable as entries } from "@workspace/db";

/** All library surfaces, including counts and direct links, share this boundary.
 * Staff authentication and module readiness are enforced by the parent router.
 * Usage groups are preserved, not broadened into customer disclosure permission.
 */
export function libraryEligibility() {
  return and(
    eq(entries.reviewStatus, "approved"),
    sql`(${entries.effectiveDate} IS NULL OR ${entries.effectiveDate} <= CURRENT_DATE)`,
    sql`(${entries.expiresDate} IS NULL OR ${entries.expiresDate} >= CURRENT_DATE)`,
  );
}

export function libraryFilters(q?: string, category?: string) {
  const conditions = [libraryEligibility()];
  if (category) conditions.push(eq(entries.category, category));
  if (q?.trim()) {
    const like = `%${q.trim().replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(sql`(
      ${entries.title} ILIKE ${like} ESCAPE '\\'
      OR ${entries.body} ILIKE ${like} ESCAPE '\\'
      OR ${entries.category} ILIKE ${like} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM unnest(${entries.tags}) AS tag WHERE tag ILIKE ${like} ESCAPE '\\')
    )`);
  }
  return and(...conditions);
}
