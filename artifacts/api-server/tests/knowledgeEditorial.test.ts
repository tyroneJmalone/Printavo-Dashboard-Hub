import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldDemoteApprovedEntry,
  visibleContentChanged,
  type KnowledgeVisibleFields,
} from "../src/lib/knowledgeEditorial";
import { UpdateKnowledgeEntryBody } from "@workspace/api-zod";

const approved: KnowledgeVisibleFields = {
  title: "Standard turnaround time",
  body: "Standard turnaround is 10 business days from art approval.",
  category: "policy",
  tags: ["turnaround", "production"],
  effectiveDate: "2026-01-01",
  expiresDate: null,
};

test("every AI-visible field change demotes an approved entry", () => {
  const cases: Array<[string, Parameters<typeof visibleContentChanged>[1]]> = [
    ["title", { title: "Rush turnaround time" }],
    ["body", { body: "Standard turnaround is 15 business days." }],
    ["category", { category: "pricing" }],
    ["tags (different value)", { tags: ["turnaround", "rush"] }],
    ["tags (added)", { tags: ["turnaround", "production", "rush"] }],
    ["tags (removed)", { tags: ["turnaround"] }],
    ["effectiveDate", { effectiveDate: "2026-06-01" }],
    ["effectiveDate cleared", { effectiveDate: null }],
    ["expiresDate", { expiresDate: "2026-12-31" }],
  ];
  for (const [label, fields] of cases) {
    assert.equal(
      shouldDemoteApprovedEntry("approved", approved, fields),
      true,
      `expected demotion when ${label} changes`,
    );
  }
});

test("source-only edits never demote (staff-only breadcrumbs, never served)", () => {
  assert.equal(
    shouldDemoteApprovedEntry("approved", approved, {
      sourceName: "2026 ops handbook",
      sourceUrl: "https://example.com/handbook",
    }),
    false,
  );
});

test("no-op saves (same values resubmitted) do not demote", () => {
  assert.equal(
    shouldDemoteApprovedEntry("approved", approved, {
      title: approved.title,
      body: approved.body,
      category: approved.category,
      tags: [...approved.tags],
      effectiveDate: approved.effectiveDate,
      expiresDate: approved.expiresDate,
    }),
    false,
  );
});

test("draft and archived entries are never demoted (nothing to demote)", () => {
  assert.equal(shouldDemoteApprovedEntry("draft", approved, { body: "new" }), false);
  assert.equal(shouldDemoteApprovedEntry("archived", approved, { body: "new" }), false);
});

test("bypass flags are stripped by the request schema, not honored", () => {
  const parsed = UpdateKnowledgeEntryBody.parse({
    body: "Changed policy text.",
    keepStatus: true,
    skipReview: true,
  });
  assert.equal("keepStatus" in parsed, false, "keepStatus must not survive validation");
  assert.equal("skipReview" in parsed, false, "unknown flags must not survive validation");
  // And the surviving fields still demote.
  assert.equal(shouldDemoteApprovedEntry("approved", approved, parsed), true);
});
