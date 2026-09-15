import assert from "node:assert/strict";
import test from "node:test";
import {
  canRetryKnowledgeDocument,
  importFailurePatch,
  normalizeDraftTitle,
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

test("retry only permits failed or zero-draft documents without approvals", () => {
  assert.equal(canRetryKnowledgeDocument({ status: "error", draftCount: 0 }, false), true);
  assert.equal(canRetryKnowledgeDocument({ status: "active", draftCount: 0 }, false), true);
  assert.equal(canRetryKnowledgeDocument({ status: "active", draftCount: 2 }, false), false);
  assert.equal(canRetryKnowledgeDocument({ status: "processing", draftCount: 0 }, false), false);
  assert.equal(canRetryKnowledgeDocument({ status: "error", draftCount: 0 }, true), false);
});