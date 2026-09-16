import { createHash } from "node:crypto";

export type ToneRecoveryPreviewCandidate = {
  candidateId: string;
  sourceKeys: string[];
};

export type ToneRecoveryPreviewBinding = {
  staffId: string;
  documentId: string;
  sourceId: string;
  sourceUpdatedAt: string;
  documentChecksum: string;
  extractedTextDigest: string;
  expiresAt: number;
  candidates: ToneRecoveryPreviewCandidate[];
};

export type ToneRecoveryCurrentDocument = {
  staffId: string;
  documentId: string;
  sourceId: string;
  sourceUpdatedAt: string;
  documentChecksum: string;
  extractedTextDigest: string;
  now?: number;
};

export function extractedTextDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableToneRecoveryCandidateId(sourceKeys: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ sourceKeys: [...sourceKeys].sort() }))
    .digest("hex");
}

/**
 * The preview is bound to the exact document/source version observed by the
 * model. The route calls this only after locking the current document row.
 */
export function toneRecoveryPreviewMismatch(
  binding: ToneRecoveryPreviewBinding,
  current: ToneRecoveryCurrentDocument,
): string | null {
  if (binding.staffId !== current.staffId) return "preview belongs to another staff session";
  if (binding.documentId !== current.documentId) return "preview belongs to another document";
  if (binding.sourceId !== current.sourceId) return "the document source changed";
  if (binding.sourceUpdatedAt !== current.sourceUpdatedAt) return "the source changed";
  if (binding.documentChecksum !== current.documentChecksum) return "the uploaded document changed";
  if (binding.extractedTextDigest !== current.extractedTextDigest) return "stored extracted text changed";
  if ((current.now ?? Date.now()) >= binding.expiresAt) return "preview expired";
  return null;
}

export function selectToneRecoveryPreviewCandidates(
  binding: ToneRecoveryPreviewBinding,
  candidateIds: string[],
  current: ToneRecoveryCurrentDocument,
): { candidates?: ToneRecoveryPreviewCandidate[]; error?: string } {
  const mismatch = toneRecoveryPreviewMismatch(binding, current);
  if (mismatch) return { error: `Tone recovery preview is stale: ${mismatch}` };
  if (new Set(candidateIds).size !== candidateIds.length) {
    return { error: "Candidate ids must be unique" };
  }
  const byId = new Map(binding.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const candidates = candidateIds.map((candidateId) => byId.get(candidateId));
  if (candidates.some((candidate) => !candidate)) {
    return { error: "One or more recovery candidates are not in the preview" };
  }
  return { candidates: candidates as ToneRecoveryPreviewCandidate[] };
}