import assert from "node:assert/strict";
import test from "node:test";
import {
  BulkDeleteKnowledgeEntriesBody,
  CommitKnowledgeMergeBody,
  PreviewKnowledgeMergeBody,
} from "@workspace/api-zod";
import {
  issueKnowledgeMergeToken,
  mergeSnapshotsMatch,
  takeKnowledgeMergeToken,
} from "../src/lib/knowledgeMerge";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const snapshots = ids.map((id, index) => ({
  id,
  updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
  reviewStatus: index === 0 ? "draft" as const : "approved" as const,
}));

test("bulk delete requires explicit confirmation and enforces the maximum", () => {
  assert.equal(
    BulkDeleteKnowledgeEntriesBody.safeParse({ entryIds: ids, snapshots, confirm: false }).success,
    true,
  );
  assert.equal(
    BulkDeleteKnowledgeEntriesBody.safeParse({ entryIds: ids }).success,
    false,
  );
  assert.equal(
    BulkDeleteKnowledgeEntriesBody.safeParse({
      entryIds: Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
      snapshots: Array.from({ length: 101 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        updatedAt: "2026-01-01T00:00:00.000Z",
        reviewStatus: "draft",
      })),
      confirm: true,
    }).success,
    false,
  );
});

test("merge request schemas require at least two entries and a complete editable candidate", () => {
  assert.equal(PreviewKnowledgeMergeBody.safeParse({ entryIds: [ids[0]] }).success, false);
  assert.equal(
    PreviewKnowledgeMergeBody.safeParse({ entryIds: ids }).success,
    true,
  );
  assert.equal(
    CommitKnowledgeMergeBody.safeParse({
      token: "preview-token",
      entryIds: ids,
      candidate: {
        title: "Merged policy",
        body: "Preserved facts.",
        category: "policy",
        tags: [],
        effectiveDate: null,
        expiresDate: null,
      },
    }).success,
    true,
  );
});

test("merge snapshot tokens are owner-bound and single-use", () => {
  const mergeSnapshots = ids.map((id, index) => ({
    id,
    updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
  }));
  const token = issueKnowledgeMergeToken("admin-1", mergeSnapshots);
  assert.equal(takeKnowledgeMergeToken(token, "other-admin", ids), null);
  assert.deepEqual(takeKnowledgeMergeToken(token, "admin-1", ids), {
    snapshots: mergeSnapshots,
    links: [],
  });
  assert.equal(takeKnowledgeMergeToken(token, "admin-1", ids), null);
});

test("snapshot comparison rejects concurrent edits or missing entries", () => {
  const expected = [{ id: ids[0], updatedAt: "2026-01-01T00:00:00.000Z" }];
  assert.equal(mergeSnapshotsMatch(expected, expected), true);
  assert.equal(
    mergeSnapshotsMatch(expected, [{ ...expected[0], updatedAt: "2026-01-02T00:00:00.000Z" }]),
    false,
  );
  assert.equal(mergeSnapshotsMatch(expected, []), false);
});