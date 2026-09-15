import assert from "node:assert/strict";
import test from "node:test";
import {
  canRetryKnowledgeDocument,
  chunkExtractedText,
  draftOnlyUnsharedEntryIds,
  importFailurePatch,
  isMeaningfulDraftFragment,
  isMeaningfulFragment,
  isRetryableTransactionAbort,
  normalizeExtractedText,
  normalizeDraftTitle,
  semanticBatches,
  validateSemanticDraftCoverage,
} from "../src/lib/knowledgeSourceImport";

test("short model titles use the source section title and keep importable metadata", () => {
  assert.equal(
    normalizeDraftTitle("AI", "Rush production policy", "Operations handbook", 2),
    "Rush production policy",
  );
  assert.equal(
    normalizeDraftTitle("  ", "  ", "Operations handbook", 2),
    "Operations handbook — section 3",
  );
  assert.equal(
    normalizeDraftTitle("A useful title", "Source heading", "Operations handbook", 2),
    "A useful title",
  );
});

test("failed-document bookkeeping does not clear extracted text", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const patch = importFailurePatch("AI extraction failed", "admin@example.com", now);
  assert.deepEqual(patch, {
    status: "error",
    lastError: "AI extraction failed",
    updatedByEmail: "admin@example.com",
    updatedAt: now,
  });
  assert.equal("extractedText" in patch, false);
});

test("retry permits failed or unapproved documents but never approved documents", () => {
  assert.equal(canRetryKnowledgeDocument({ status: "error", draftCount: 0 }, false), true);
  assert.equal(canRetryKnowledgeDocument({ status: "active", draftCount: 0 }, false), true);
  assert.equal(canRetryKnowledgeDocument({ status: "active", draftCount: 2 }, false), true);
  assert.equal(canRetryKnowledgeDocument({ status: "stale", draftCount: 4 }, false), true);
  assert.equal(canRetryKnowledgeDocument({ status: "processing", draftCount: 0 }, false), false);
  assert.equal(canRetryKnowledgeDocument({ status: "error", draftCount: 0 }, true), false);
});

test("reconstructs PDF-like visual lines and does not turn each line into a draft window", () => {
  const text = [
    "Rush production policy",
    "Rush orders are accepted only after art approval.",
    "The production team confirms the available delivery date.",
    "",
    "Exceptions:",
    "- A rush fee may apply.",
    "- The rush option is unavailable for some specialty items.",
  ].join("\n");
  const normalized = normalizeExtractedText(text);
  assert.match(normalized, /Rush orders are accepted only after art approval\. The production team/);
  assert.match(normalized, /- A rush fee may apply\.\n- The rush option/);
  const sections = chunkExtractedText(text);
  assert.equal(sections.length, 1);
  assert.ok(sections[0]!.body.length > 150);
});

test("joins blank-line-separated PDF word fragments while preserving list lines", () => {
  const text = [
    "Rush",
    "",
    "orders",
    "",
    "are",
    "",
    "accepted",
    "",
    "only",
    "",
    "after",
    "",
    "art",
    "",
    "approval.",
    "",
    "- A rush fee applies.",
    "",
    "- Specialty items are excluded.",
  ].join("\n");
  const normalized = normalizeExtractedText(text);
  assert.match(normalized, /Rush orders are accepted only after art approval\./);
  assert.match(normalized, /- A rush fee applies\.\n- Specialty items are excluded\./);
  assert.equal(chunkExtractedText(text).length, 1);
});

test("allows multiple semantic topics to cite one bounded source window", () => {
  assert.deepEqual(
    validateSemanticDraftCoverage(new Set([0]), [[0], [0]]),
    [[0], [0]],
  );
  assert.deepEqual(
    validateSemanticDraftCoverage(new Set([0, 1]), [[0], [0, 1]]),
    [[0], [0, 1]],
  );
  assert.throws(
    () => validateSemanticDraftCoverage(new Set([0, 1]), [[0]]),
    /cover every meaningful source window/,
  );
});

test("retains short negative rules at a bounded-window tail", () => {
  const text = `${"Rush orders require written production confirmation. ".repeat(12)}No refunds.`;
  assert.equal(isMeaningfulFragment("No refunds."), true);
  const sections = chunkExtractedText(text, 200);
  assert.ok(sections.some((section) => /No refunds\./.test(section.body)));
});

test("retains concise positive rules and dollar-amount tails as source material", () => {
  assert.equal(isMeaningfulFragment("Cash only."), true);
  assert.equal(isMeaningfulFragment("$40 fee."), true);
  assert.equal(isMeaningfulFragment("...---"), false);
  assert.equal(isMeaningfulDraftFragment("Cash only."), true);
  assert.equal(isMeaningfulDraftFragment("Cash"), false);
  const sections = chunkExtractedText(
    `${"Production requires written confirmation. ".repeat(12)}Cash only. $40 fee.`,
    200,
  );
  assert.ok(sections.some((section) => /Cash only\./.test(section.body)));
  assert.ok(sections.some((section) => /\$40 fee\./.test(section.body)));
});

test("identifies PostgreSQL deadlock and serialization aborts as transient", () => {
  assert.equal(isRetryableTransactionAbort({ code: "40P01" }), true);
  assert.equal(isRetryableTransactionAbort({ code: "40001" }), true);
  assert.equal(isRetryableTransactionAbort(new Error("deadlock detected")), true);
  assert.equal(isRetryableTransactionAbort("serialization failure"), true);
  assert.equal(
    isRetryableTransactionAbort({ cause: new Error("could not serialize access") }),
    true,
  );
  assert.equal(isRetryableTransactionAbort({ code: "23505" }), false);
});

test("revalidation preserves approvals and shared entries after concurrent changes", () => {
  const entries = [
    { entryId: "draft-only", reviewStatus: "draft" },
    { entryId: "approved-during-ai", reviewStatus: "approved" },
    { entryId: "shared-during-ai", reviewStatus: "draft" },
  ];
  const links = [
    { entryId: "draft-only", documentId: "document-a" },
    { entryId: "approved-during-ai", documentId: "document-a" },
    { entryId: "shared-during-ai", documentId: "document-a" },
    { entryId: "shared-during-ai", documentId: "document-b" },
  ];
  assert.deepEqual(
    draftOnlyUnsharedEntryIds(entries, links, "document-a"),
    ["draft-only"],
  );
});

test("semantic batches keep every bounded window without silent truncation", () => {
  const source = Array.from({ length: 8 }, (_, index) => ({
    title: `Policy ${index + 1}`,
    body: `Policy ${index + 1} says this factual rule applies to orders in group ${index + 1}.`,
  }));
  const batches = semanticBatches(source, 200);
  assert.ok(batches.length > 1);
  assert.deepEqual(
    batches.flat().map((section) => section.title),
    source.map((section) => section.title),
  );
  assert.ok(batches.every((batch) => batch.length > 0));
});