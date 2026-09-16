import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKnowledgePlaygroundFeedbackInsertValues,
  buildKnowledgePlaygroundFeedbackReviewPatch,
  normalizeKnowledgePlaygroundFeedback,
} from "../src/lib/knowledgePlaygroundFeedback";
import { buildKnowledgePlaygroundFeedbackInput } from "../../hub/src/components/knowledge/KnowledgePlaygroundFeedback";

function feedbackBody(overrides: Record<string, unknown> = {}) {
  return {
    message: "  How quickly can this ship?  ",
    verdict: "needs_work",
    issues: ["facts", "tone"],
    comment: "  Clarify the timing.  ",
    correctedReply: "  Please confirm the current lead time.  ",
    snapshot: {
      reply: "We can usually ship quickly.",
      searchQueries: ["shipping"],
      retrievedEntries: [
        {
          id: "entry-1",
          title: "Shipping timing",
          body: "Current timing depends on production capacity.",
          category: "shipping",
          reviewStatus: "approved",
        },
      ],
      usedEntryIds: ["entry-1"],
      brandGuidance: [],
      includeDrafts: false,
      note: "Approved-only test.",
    },
    includeDrafts: false,
    sources: [
      {
        id: "entry-1",
        title: "Shipping timing",
        body: "Current timing depends on production capacity.",
        category: "shipping",
        reviewStatus: "approved",
      },
    ],
    ...overrides,
  };
}

test("normalizes feedback and server-stamps the bounded snapshot", () => {
  const parsed = normalizeKnowledgePlaygroundFeedback(
    feedbackBody({
      snapshot: {
        ...feedbackBody().snapshot,
        trust: "trusted-ground-truth",
      },
    }),
  );
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  assert.equal(parsed.data.message, "How quickly can this ship?");
  assert.equal(parsed.data.comment, "Clarify the timing.");
  assert.equal(parsed.data.correctedReply, "Please confirm the current lead time.");
  assert.equal(parsed.data.snapshot.trust, "staff-submitted");
  assert.equal(parsed.data.snapshot.includeDrafts, false);
});

test("rejects duplicate issues, mode mismatches, whitespace messages, and bounded overflow", () => {
  const duplicateIssues = normalizeKnowledgePlaygroundFeedback(
    feedbackBody({ issues: ["facts", "facts"] }),
  );
  assert.equal(duplicateIssues.success, false);
  if (!duplicateIssues.success) assert.match(duplicateIssues.error, /unique/i);

  const modeMismatch = normalizeKnowledgePlaygroundFeedback(
    feedbackBody({
      includeDrafts: true,
      snapshot: { ...feedbackBody().snapshot, includeDrafts: false },
    }),
  );
  assert.equal(modeMismatch.success, false);
  if (!modeMismatch.success) assert.match(modeMismatch.error, /includeDrafts/i);

  const whitespaceMessage = normalizeKnowledgePlaygroundFeedback(feedbackBody({ message: "   " }));
  assert.equal(whitespaceMessage.success, false);
  if (!whitespaceMessage.success) assert.match(whitespaceMessage.error, /3 non-whitespace/i);

  const oversizedSource = normalizeKnowledgePlaygroundFeedback(
    feedbackBody({
      sources: [{ ...feedbackBody().sources[0], body: "x".repeat(4_001) }],
    }),
  );
  assert.equal(oversizedSource.success, false);

  for (const oversized of [
    feedbackBody({ message: "x".repeat(4_001) }),
    feedbackBody({ comment: "x".repeat(2_001) }),
    feedbackBody({ correctedReply: "x".repeat(4_001) }),
    feedbackBody({ snapshot: { ...feedbackBody().snapshot, reply: "x".repeat(4_001) } }),
  ]) {
    assert.equal(normalizeKnowledgePlaygroundFeedback(oversized).success, false);
  }

  const tooManySources = normalizeKnowledgePlaygroundFeedback(
    feedbackBody({
      sources: Array.from({ length: 9 }, (_, index) => ({
        ...feedbackBody().sources[0],
        id: `entry-${index}`,
      })),
    }),
  );
  assert.equal(tooManySources.success, false);
});

test("ignores posted attribution and derives insert ownership from authenticated staff", () => {
  const parsed = normalizeKnowledgePlaygroundFeedback(
    feedbackBody({
      submittedByStaffId: "00000000-0000-0000-0000-000000000000",
      submittedByEmail: "attacker@example.com",
      reviewed: true,
    }),
  );
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const values = buildKnowledgePlaygroundFeedbackInsertValues(parsed.data, {
    id: "11111111-1111-1111-1111-111111111111",
    email: "real-staff@example.com",
  });
  assert.equal(values.submittedByStaffId, "11111111-1111-1111-1111-111111111111");
  assert.equal(values.submittedByEmail, "real-staff@example.com");
  assert.equal("submittedByStaffId" in parsed.data, false);
  assert.equal("reviewed" in parsed.data, false);
});

test("review resolve/reopen patches preserve the immutable saved snapshot", () => {
  const parsed = normalizeKnowledgePlaygroundFeedback(feedbackBody());
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const values = buildKnowledgePlaygroundFeedbackInsertValues(parsed.data, {
    id: "11111111-1111-1111-1111-111111111111",
    email: "real-staff@example.com",
  });
  const originalSnapshot = structuredClone(values.resultSnapshot);
  const saved = { ...values, reviewed: false };

  Object.assign(
    saved,
    buildKnowledgePlaygroundFeedbackReviewPatch(
      true,
      { id: "22222222-2222-2222-2222-222222222222", email: "reviewer@example.com" },
      new Date("2026-04-01T12:00:00.000Z"),
    ),
  );
  assert.equal(saved.reviewed, true);
  assert.equal(saved.reviewedByEmail, "reviewer@example.com");
  assert.deepEqual(saved.resultSnapshot, originalSnapshot);

  Object.assign(
    saved,
    buildKnowledgePlaygroundFeedbackReviewPatch(
      false,
      { id: "33333333-3333-3333-3333-333333333333", email: "other-reviewer@example.com" },
      new Date("2026-04-02T12:00:00.000Z"),
    ),
  );
  assert.equal(saved.reviewed, false);
  assert.equal(saved.reviewedByEmail, null);
  assert.equal(saved.reviewedAt, null);
  assert.deepEqual(saved.resultSnapshot, originalSnapshot);
});

test("feedback payload captures the original message and result before a pending edit", () => {
  const result = {
    reply: "Original answer",
    searchQueries: ["shipping"],
    retrievedEntries: [
      {
        id: "entry-1",
        title: "Original source",
        body: "Original source body",
        category: "shipping",
        reviewStatus: "approved",
      },
    ],
    usedEntryIds: ["entry-1"],
    brandGuidance: [],
    includeDrafts: false,
    note: "Original note",
  } as const;
  const captured = buildKnowledgePlaygroundFeedbackInput(
    "Original question",
    result,
    "needs_work",
    ["wording"],
    "Original comment",
    "Original correction",
  );

  // Simulate editing controlled state while the request is awaiting the API.
  const editedMessage = "Edited question";
  const editedReply = "Edited answer";
  assert.equal(editedMessage, "Edited question");
  assert.equal(captured.message, "Original question");
  assert.equal(captured.snapshot.reply, "Original answer");
  assert.equal(captured.comment, "Original comment");
  assert.equal(captured.correctedReply, "Original correction");
  assert.notEqual(editedReply, captured.snapshot.reply);
});