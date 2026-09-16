import assert from "node:assert/strict";
import test from "node:test";
import {
  extractedTextDigest,
  selectToneRecoveryPreviewCandidates,
  stableToneRecoveryCandidateId,
  toneRecoveryPreviewMismatch,
  type ToneRecoveryPreviewBinding,
} from "../src/lib/knowledgeToneRecoveryPolicy";
import {
  normalizeToneRecoverySourceKey,
  planToneRecovery,
  toneRecoveryTopicSourceKey,
} from "../src/lib/knowledgeSourceImport";

const current = {
  staffId: "staff-a",
  documentId: "document-a",
  sourceId: "source-a",
  sourceUpdatedAt: "2026-04-22T00:00:00.000Z",
  documentChecksum: "checksum-a",
  extractedTextDigest: extractedTextDigest("stored text"),
  now: 1_000,
};

function binding(overrides: Partial<ToneRecoveryPreviewBinding> = {}): ToneRecoveryPreviewBinding {
  const sourceKeys = ["tone-v1:source-window:topic:0"];
  return {
    staffId: current.staffId,
    documentId: current.documentId,
    sourceId: current.sourceId,
    sourceUpdatedAt: current.sourceUpdatedAt,
    documentChecksum: current.documentChecksum,
    extractedTextDigest: current.extractedTextDigest,
    expiresAt: 2_000,
    candidates: [{ candidateId: stableToneRecoveryCandidateId(sourceKeys), sourceKeys }],
    ...overrides,
  };
}

test("preview selection rejects cross-staff, expired, forged, changed, and deleted-document bindings", () => {
  const candidateId = binding().candidates[0]!.candidateId;
  assert.equal(
    toneRecoveryPreviewMismatch(binding(), { ...current, staffId: "staff-b" }),
    "preview belongs to another staff session",
  );
  assert.equal(
    toneRecoveryPreviewMismatch(binding({ expiresAt: 999 }), current),
    "preview expired",
  );
  assert.equal(
    toneRecoveryPreviewMismatch(binding(), { ...current, documentChecksum: "changed" }),
    "the uploaded document changed",
  );
  assert.equal(
    toneRecoveryPreviewMismatch(binding(), { ...current, extractedTextDigest: extractedTextDigest("new text") }),
    "stored extracted text changed",
  );
  assert.equal(
    toneRecoveryPreviewMismatch(binding(), { ...current, sourceId: "deleted-source" }),
    "the document source changed",
  );
  assert.equal(
    toneRecoveryPreviewMismatch(binding(), { ...current, sourceUpdatedAt: "2026-04-23T00:00:00.000Z" }),
    "the source changed",
  );
  assert.equal(
    selectToneRecoveryPreviewCandidates(binding(), ["forged-candidate-id"], current).error,
    "One or more recovery candidates are not in the preview",
  );
  assert.equal(
    selectToneRecoveryPreviewCandidates(binding(), [candidateId], current).candidates?.[0]?.candidateId,
    candidateId,
  );
});

test("paraphrased previews keep source identity while two same-window topics retain separate slots", () => {
  const first = ["tone-v1:source-window:topic:0", "tone-v1:source-window:topic:1"];
  const paraphrased = [...first];
  assert.equal(stableToneRecoveryCandidateId(first), stableToneRecoveryCandidateId(paraphrased));
  assert.notEqual(
    stableToneRecoveryCandidateId([first[0]!]),
    stableToneRecoveryCandidateId([first[1]!]),
  );
});

test("concurrent-style recovery plans preserve edited approvals and suppress paraphrase repeats", () => {
  const sourceKeys = ["tone-v1:source-window:topic:0"];
  const approvedEdited = {
    title: "Editorial title",
    body: "Human-edited approved guidance.",
    tags: ["voice"],
    sourceKeys,
    entryId: "approved",
    reviewStatus: "approved",
  };
  const paraphrase = {
    title: "Different model title",
    body: "A paraphrased version of the same source guidance.",
    tags: ["different-model-tag"],
    sourceKeys,
  };
  const first = planToneRecovery([paraphrase], [approvedEdited]);
  assert.equal(first.toInsert.length, 0);
  assert.equal(first.approvedPreserved, 1);
  const second = planToneRecovery([paraphrase], [approvedEdited]);
  assert.equal(second.toInsert.length, 0);
  assert.equal(second.skippedExisting, 1);
});

test("approved normal-import tone slot suppresses recovery paraphrase while later slot remains addable", () => {
  const base = `tone-v1:${"a".repeat(64)}`;
  const legacyNormalLink = normalizeToneRecoverySourceKey(base);
  assert.equal(
    normalizeToneRecoverySourceKey(`${"a".repeat(64)}:tone`),
    legacyNormalLink,
  );
  const slotZero = toneRecoveryTopicSourceKey(base, 0);
  const slotOne = toneRecoveryTopicSourceKey(base, 1);
  assert.equal(legacyNormalLink, slotZero);
  const approvedNormalTone = {
    title: "Normal import title",
    body: "Human-edited approved tone.",
    tags: ["voice"],
    sourceKeys: [legacyNormalLink],
    entryId: "approved-normal-tone",
    reviewStatus: "approved",
  };
  const repeatedRecovery = planToneRecovery(
    [{
      title: "Paraphrased recovery title",
      body: "Different model wording for the same source topic.",
      tags: ["different"],
      sourceKeys: [slotZero],
    }],
    [approvedNormalTone],
  );
  assert.equal(repeatedRecovery.toInsert.length, 0);
  assert.equal(repeatedRecovery.approvedPreserved, 1);
  const additionalTopic = planToneRecovery(
    [{
      title: "Second source topic",
      body: "A distinct topic from the same source window.",
      tags: ["voice"],
      sourceKeys: [slotOne],
    }],
    [approvedNormalTone],
  );
  assert.equal(additionalTopic.toInsert.length, 1);
});

test("exact tone applicability dates remain attached to a new draft", () => {
  const dated = {
    title: "Anniversary voice",
    body: "Use this wording during the documented campaign window.",
    tags: ["campaign"],
    sourceKeys: ["tone-v1:anniversary-window:topic:0"],
    effectiveDate: "2026-04-01",
    expiresDate: "2027-04-30",
  };
  const plan = planToneRecovery([dated], []);
  assert.equal(plan.toInsert[0]?.effectiveDate, "2026-04-01");
  assert.equal(plan.toInsert[0]?.expiresDate, "2027-04-30");
});