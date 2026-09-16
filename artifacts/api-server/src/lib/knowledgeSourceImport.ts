import { createHash } from "node:crypto";

export type KnowledgeSourceSection = {
  title: string;
  body: string;
};

export type KnowledgeDraftKind = "fact" | "tone";

export const DATE_BOUND_APPLICABILITY_REVIEW_WARNING =
  "Applicability review required: the source gives a seasonal, month-only, or anniversary window without exact dates. Do not treat this draft as evergreen until exact applicability dates are confirmed.";

export function applicabilityReviewBody(body: string): string {
  return `${DATE_BOUND_APPLICABILITY_REVIEW_WARNING}\n\n${body}`;
}

export function toneRecoveryTopicSourceKey(baseKey: string, topicSlot: number): string {
  if (!Number.isInteger(topicSlot) || topicSlot < 0) {
    throw new Error("topicSlot must be a non-negative integer");
  }
  return `${baseKey}:topic:${topicSlot}`;
}

/**
 * Imports created before topic slots were introduced used the base tone key.
 * Treat that one legacy key as topic slot zero so normal imports and recovery
 * remain idempotent without collapsing later distinct same-window topics.
 */
export function normalizeToneRecoverySourceKey(sectionKey: string): string {
  if (/^tone-v1:[a-f0-9]{64}$/.test(sectionKey)) {
    return toneRecoveryTopicSourceKey(sectionKey, 0);
  }
  // Early tone imports used `<hash>:tone` before the versioned namespace was
  // added. Normalize those links too; they still identify source topic zero.
  const legacyHash = /^([a-f0-9]{64}):tone$/.exec(sectionKey)?.[1];
  return legacyHash
    ? toneRecoveryTopicSourceKey(`tone-v1:${legacyHash}`, 0)
    : sectionKey;
}

/**
 * Facts and voice guidance may cite the same bounded source window. Keep their
 * link keys distinct so a factual import cannot suppress a tone candidate (or
 * vice versa) while preserving normal import idempotence.
 */
export function draftSourceSectionKey(
  section: KnowledgeSourceSection,
  kind: KnowledgeDraftKind = "fact",
): string {
  const base = createHash("sha256")
    .update(section.title + "\n" + section.body)
    .digest("hex");
  // The tone prefix is a versioned source-provenance namespace. Do not use
  // generated title/body text for tone identities: edited approved guidance
  // must continue to suppress an equivalent recovery candidate.
  return kind === "tone" ? `tone-v1:${base}` : base;
}

export type ToneRecoveryCandidateForPlan = {
  title: string;
  body: string;
  tags: string[];
  sourceKeys: string[];
  effectiveDate?: string | null;
  expiresDate?: string | null;
  dateBound?: boolean;
};

export type ExistingToneRecoveryEntryForPlan = ToneRecoveryCandidateForPlan & {
  entryId: string;
  reviewStatus: string;
};

export type ToneRecoveryPlan = {
  toInsert: ToneRecoveryCandidateForPlan[];
  skippedExisting: number;
  approvedPreserved: number;
};

/**
 * Plan recovery inserts without mutating rows. The route uses this inside its
 * transaction and the offline tests use it to prove repeated recovery is
 * idempotent. Existing approved entries are only observed, never rewritten.
 */
export function planToneRecovery(
  candidates: ToneRecoveryCandidateForPlan[],
  existing: ExistingToneRecoveryEntryForPlan[],
): ToneRecoveryPlan {
  const fingerprint = (candidate: ToneRecoveryCandidateForPlan): string =>
    toneRecoveryFingerprint(candidate);
  const existingFingerprints = new Set(existing.map(fingerprint));
  const seen = new Set<string>();
  const toInsert: ToneRecoveryCandidateForPlan[] = [];
  let skippedExisting = 0;
  let approvedPreserved = 0;

  for (const candidate of candidates) {
    const key = fingerprint(candidate);
    if (seen.has(key) || existingFingerprints.has(key)) {
      skippedExisting++;
      if (existing.some((entry) => entry.reviewStatus === "approved" && fingerprint(entry) === key)) {
        approvedPreserved++;
      }
      continue;
    }
    seen.add(key);
    toInsert.push(candidate);
  }

  return { toInsert, skippedExisting, approvedPreserved };
}

/**
 * Recovery identity is deliberately source provenance only. A model may
 * paraphrase a candidate or an editor may revise an approved body without
 * resurfacing an equivalent draft; changing the source section changes its
 * versioned source key. Topic slots distinguish multiple model-selected topics
 * that cite one bounded source window.
 */
export function toneRecoveryFingerprint(
  candidate: ToneRecoveryCandidateForPlan,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        // Recovery identity is source provenance only. The ordered topic slot
        // is already part of each source key, allowing two selected topics
        // from one source window while suppressing paraphrased repeats.
        sourceKeys: [...candidate.sourceKeys].sort(),
      }),
    )
    .digest("hex");
}

export function validateCandidateSourceIndexes(
  expectedIndexes: Set<number>,
  candidateIndexes: number[][],
): number[][] {
  return candidateIndexes.map((indexes) => {
    const unique = Array.from(new Set(indexes));
    if (!unique.length || unique.some((index) => !expectedIndexes.has(index))) {
      throw new Error("AI draft extraction returned an invalid source index");
    }
    return unique;
  });
}

/**
 * Extraction providers do not agree on where a "line" ends. In particular,
 * PDF text extraction commonly emits one line per visual line, with no useful
 * paragraph boundaries. Keep explicit list/heading boundaries, but join normal
 * prose lines before semantic windows are built.
 */
export function normalizeExtractedText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const rawBlocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (!current.length) return;
    const value = current.join("\n").trim();
    if (value) rawBlocks.push(value);
    current = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+/g, " ").trim();
    if (!line) {
      flush();
      continue;
    }
    if (current.length && isListItem(line)) {
      current.push(line);
      continue;
    }
    if (current.length && isExplicitHeading(line)) {
      flush();
    }
    if (current.length && isListItem(current[current.length - 1]!)) {
      current.push(line);
    } else if (current.length) {
      const previous = current[current.length - 1]!;
      current[current.length - 1] = /[A-Za-z]-$/.test(previous) && /^[a-z]/.test(line)
        ? previous.slice(0, -1) + line
        : previous + " " + line;
    } else {
      current.push(line);
    }
  }
  flush();

  const blocks: string[] = [];
  for (const block of rawBlocks) {
    const previous = blocks.at(-1);
    const firstLine = block.split("\n", 1)[0]!.trim();
    if (!previous) {
      blocks.push(block);
    } else if (isListItem(firstLine)) {
      blocks[blocks.length - 1] = `${previous}\n${block}`;
    } else if (isExplicitHeading(firstLine)) {
      blocks.push(block);
    } else if (
      isExplicitHeading(previous.split("\n", 1)[0]!.trim()) &&
      previous.split("\n").length === 1
    ) {
      blocks[blocks.length - 1] = `${previous} ${block}`;
    } else if (
      previous.length < 40 ||
      block.length < 40 ||
      !/[.!?]$/.test(previous)
    ) {
      // Some PDF engines put a blank line between every visual line. Short
      // adjacent blocks are therefore continuations, not separate facts.
      blocks[blocks.length - 1] = `${previous} ${block}`;
    } else {
      blocks.push(block);
    }
  }
  return blocks.join("\n\n");
}

function isListItem(line: string): boolean {
  return /^(?:[-*•▪◦]|\d+[.)]|[a-z][.)])\s+/i.test(line);
}

function isExplicitHeading(line: string): boolean {
  if (/^#{1,6}\s+\S/.test(line)) return true;
  if (line.length > 100 || /[.!?;]$/.test(line)) return false;
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 12) return false;
  return /:$/.test(line) || words.every((word) => /^[A-Z0-9/&'()_-]+$/.test(word));
}

export function isMeaningfulFragment(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  // Source text must not be filtered by an arbitrary minimum length. A
  // sentence such as "Cash only." is a complete factual rule. The only
  // universally safe extraction noise to discard here is punctuation-only
  // material.
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  return true;
}

/**
 * Model output is held to a slightly stronger standard than source
 * preservation. This prevents a punctuation/one-token model artifact from
 * becoming a draft while allowing concise factual rules such as "Cash only."
 */
export function isMeaningfulDraftFragment(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (!isMeaningfulFragment(text)) return false;
  if (/^(?:page|section|chapter)\s+\d+(?:\s+of\s+\d+)?$/i.test(text)) return false;
  const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)?/g) ?? [];
  return words.length >= 2 || /\d/.test(text);
}

function splitOversizedBlock(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  const sentences = block.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const fragments: string[] = [];
  let current = "";
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && isMeaningfulFragment(trimmed)) fragments.push(trimmed);
  };

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (!current) {
      current = sentence.trim();
    } else if ((current + " " + sentence.trim()).length <= maxChars) {
      current += " " + sentence.trim();
    } else {
      push(current);
      current = sentence.trim();
    }
  }
  push(current);

  // A long sentence has no sentence boundary to use. Split only at whitespace
  // so no source material is silently discarded.
  if (!fragments.length) {
    for (let start = 0; start < block.length; start += maxChars) {
      const piece = block.slice(start, start + maxChars).trim();
      // A continuation can be short even though the complete source block is
      // meaningful. Keep it so the bounded-window contract never truncates
      // source material at an arbitrary character boundary.
      if (piece && isMeaningfulFragment(piece)) fragments.push(piece);
    }
  } else if (fragments.some((fragment) => fragment.length > maxChars)) {
    const bounded: string[] = [];
    for (const fragment of fragments) {
      for (let start = 0; start < fragment.length; start += maxChars) {
        const piece = fragment.slice(start, start + maxChars).trim();
          if (piece && isMeaningfulFragment(piece)) bounded.push(piece);
      }
    }
    return bounded;
  }
  return fragments;
}

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
  maxChars = 6000,
): KnowledgeSourceSection[] {
  if (!Number.isInteger(maxChars) || maxChars < 200) {
    throw new Error("maxChars must be an integer of at least 200");
  }
  const normalized = normalizeExtractedText(text);
  const blocks = normalized
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => isMeaningfulFragment(block));
  const boundedBlocks = blocks.flatMap((block) => splitOversizedBlock(block, maxChars));
  const sections: KnowledgeSourceSection[] = [];
  let pending = "";

  const flushPending = () => {
    const body = pending.trim();
    if (body && isMeaningfulFragment(body)) {
      sections.push({
        title: body.split(/\r?\n/, 1)[0]!.replace(/^#{1,6}\s+/, "").slice(0, 120),
        body,
      });
    }
    pending = "";
  };

  for (const block of boundedBlocks) {
    if (!pending) {
      pending = block;
    } else if ((pending + "\n\n" + block).length <= maxChars) {
      pending += "\n\n" + block;
    } else {
      flushPending();
      pending = block;
    }
  }
  flushPending();
  return sections;
}

/**
 * Batches are bounded by source characters rather than item count. A short
 * document therefore reaches the model in one request, allowing the model to
 * group related facts instead of creating one draft for every visual fragment.
 * Larger documents retain every coherent window and are processed in order.
 */
export function semanticBatches(
  sections: KnowledgeSourceSection[],
  maxChars = 18000,
): KnowledgeSourceSection[][] {
  if (!Number.isInteger(maxChars) || maxChars < 200) {
    throw new Error("maxChars must be an integer of at least 200");
  }
  const batches: KnowledgeSourceSection[][] = [];
  let batch: KnowledgeSourceSection[] = [];
  let length = 0;
  for (const section of sections) {
    if (batch.length && length + section.body.length > maxChars) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(section);
    length += section.body.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * A bounded source window can contain several unrelated topics. The model may
 * therefore cite the same index in more than one candidate; coverage, rather
 * than uniqueness, is the invariant that prevents silent source loss.
 */
export function validateSemanticDraftCoverage(
  expectedIndexes: Set<number>,
  candidateIndexes: number[][],
): number[][] {
  const covered = new Set<number>();
  const normalized = candidateIndexes.map((indexes) => {
    const unique = Array.from(new Set(indexes));
    if (!unique.length || unique.some((index) => !expectedIndexes.has(index))) {
      throw new Error("AI draft extraction returned an invalid source index");
    }
    unique.forEach((index) => covered.add(index));
    return unique;
  });
  if (covered.size !== expectedIndexes.size) {
    throw new Error("AI draft extraction did not cover every meaningful source window");
  }
  return normalized;
}

export type RegenerationEntryState = {
  entryId: string;
  reviewStatus: string;
};

export type RegenerationLinkState = {
  entryId: string;
  documentId: string;
};

/**
 * Revalidation helper for the replacement transaction. It intentionally
 * requires the caller to provide the post-lock rows, so an approval or a new
 * cross-document link observed after model enrichment cannot be mistaken for
 * a draft-only entry.
 */
export function draftOnlyUnsharedEntryIds(
  entries: RegenerationEntryState[],
  links: RegenerationLinkState[],
  documentId: string,
): string[] {
  const documentsByEntry = new Map<string, Set<string>>();
  for (const link of links) {
    const documents = documentsByEntry.get(link.entryId) ?? new Set<string>();
    documents.add(link.documentId);
    documentsByEntry.set(link.entryId, documents);
  }
  return Array.from(new Set(
    entries
      .filter((entry) =>
        entry.reviewStatus === "draft" &&
        documentsByEntry.get(entry.entryId)?.size === 1 &&
        documentsByEntry.get(entry.entryId)?.has(documentId),
      )
      .map((entry) => entry.entryId),
  ));
}

/**
 * A retry can replace draft-only material, but never entries that have already
 * been approved. Shared entries are protected by the database transaction in
 * knowledgeSources.ts; this predicate only decides whether regeneration may
 * be attempted.
 */
export function canRetryKnowledgeDocument(
  document: RetryDocumentState,
  hasApprovedEntries: boolean,
): boolean {
  if (hasApprovedEntries) return false;
  if (document.status === "error") return true;
  return ["active", "stale"].includes(document.status);
}

export type RetryDocumentState = {
  status: string;
  draftCount: number;
};

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

/**
 * PostgreSQL uses these SQLSTATEs when a transaction must be retried. They
 * are transient coordination failures, not evidence that document extraction
 * or AI enrichment failed.
 */
export function isRetryableTransactionAbort(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const record = current as { code?: unknown; cause?: unknown; message?: unknown };
      if (record.code === "40P01" || record.code === "40001") return true;
      if (
        typeof record.message === "string" &&
        /deadlock detected|could not serialize access|serialization failure/i.test(record.message)
      ) {
        return true;
      }
      current = record.cause;
      continue;
    }
    if (
      typeof current === "string" &&
      /deadlock detected|could not serialize access|serialization failure/i.test(current)
    ) {
      return true;
    }
    break;
  }
  return false;
}