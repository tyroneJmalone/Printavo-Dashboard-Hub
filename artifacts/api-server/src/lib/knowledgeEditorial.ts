/**
 * Editorial rules for the knowledge base that feeds the AI context layer.
 *
 * The invariant: an APPROVED entry goes back to draft whenever ANY
 * AI-visible or retrieval-affecting field changes — title, body, category,
 * tags, or the effective/expires window. There is deliberately NO bypass
 * flag: "this edit is cosmetic" is a claim review exists to verify.
 * Only the staff-only source breadcrumbs (sourceName/sourceUrl) are exempt,
 * because no door ever serves them.
 */

export interface KnowledgeVisibleFields {
  title: string;
  body: string;
  category: string;
  tags: string[];
  effectiveDate: string | null;
  expiresDate: string | null;
}

export interface KnowledgeUpdateFields {
  title?: string;
  body?: string;
  category?: string;
  tags?: string[];
  effectiveDate?: string | null;
  expiresDate?: string | null;
  /** Staff-only breadcrumbs — never served, never trigger demotion. */
  sourceName?: string;
  sourceUrl?: string;
}

/** True when the update changes anything AI consumers can see or search by. */
export function visibleContentChanged(
  existing: KnowledgeVisibleFields,
  fields: KnowledgeUpdateFields,
): boolean {
  const tagsChanged =
    fields.tags !== undefined &&
    (fields.tags.length !== existing.tags.length ||
      fields.tags.some((tag, i) => tag !== existing.tags[i]));
  return (
    (fields.title !== undefined && fields.title !== existing.title) ||
    (fields.body !== undefined && fields.body !== existing.body) ||
    (fields.category !== undefined && fields.category !== existing.category) ||
    tagsChanged ||
    (fields.effectiveDate !== undefined && fields.effectiveDate !== existing.effectiveDate) ||
    (fields.expiresDate !== undefined && fields.expiresDate !== existing.expiresDate)
  );
}

/** True when saving this update must demote the entry to draft for re-review. */
export function shouldDemoteApprovedEntry(
  reviewStatus: string,
  existing: KnowledgeVisibleFields,
  fields: KnowledgeUpdateFields,
): boolean {
  return reviewStatus === "approved" && visibleContentChanged(existing, fields);
}
