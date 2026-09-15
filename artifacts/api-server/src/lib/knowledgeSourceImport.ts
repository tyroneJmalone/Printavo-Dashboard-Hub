export type KnowledgeSourceSection = {
  title: string;
  body: string;
};

/**
 * Titles are editorial metadata, not source content. An LLM may occasionally
 * return a one- or two-character title; keep the candidate and use the
 * source section heading instead of rejecting the entire import.
 */
export function normalizeDraftTitle(
  candidateTitle: string,
  sourceSectionTitle: string,
  sourceName: string,
  sectionIndex: number,
): string {
  const candidate = candidateTitle.trim();
  if (candidate.length >= 3) return candidate.slice(0, 160);

  const sectionTitle = sourceSectionTitle.trim();
  if (sectionTitle.length >= 3) return sectionTitle.slice(0, 160);

  const source = sourceName.trim();
  if (source.length >= 3) {
    return `${source} — section ${sectionIndex + 1}`.slice(0, 160);
  }

  return `Imported section ${sectionIndex + 1}`;
}

/**
 * Rebuild the deterministic sections produced by kb_extract.py from the
 * stored extracted text. This is used by retry so a retry never needs the
 * original upload bytes.
 */
export function chunkExtractedText(
  text: string,
  maxChars = 1800,
): KnowledgeSourceSection[] {
  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const sections: KnowledgeSourceSection[] = [];

  for (const block of blocks) {
    const parts = block
      .split(/^(?=#{1,6}\s)|^(?=[A-Z][A-Za-z0-9 /&'_-]{2,80}:?\s*$)/m)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      for (let start = 0; start < part.length; start += maxChars) {
        const body = part.slice(start, start + maxChars).trim();
        if (!body) continue;
        sections.push({
          title: body.split(/\r?\n/, 1)[0]!.slice(0, 120),
          body,
        });
        if (sections.length >= 60) return sections;
      }
    }
  }

  return sections;
}

export type RetryDocumentState = {
  status: string;
  draftCount: number;
};

/**
 * Retry is intentionally narrow: failed imports and imports that produced no
 * drafts can be regenerated, but an approved entry is never reset or
 * overwritten by this workflow.
 */
export function canRetryKnowledgeDocument(
  document: RetryDocumentState,
  hasApprovedEntries: boolean,
): boolean {
  if (hasApprovedEntries) return false;
  if (document.status === "error") return true;
  return document.draftCount === 0 &&
    (document.status === "active" || document.status === "stale");
}

/**
 * The extracted text is deliberately absent from this patch. Updating a
 * failed document must not clear the text that staff need for preview/retry.
 */
export function importFailurePatch(error: string, email: string, now = new Date()) {
  return {
    status: "error",
    lastError: error,
    updatedByEmail: email,
    updatedAt: now,
  } as const;
}