import { Router, type IRouter } from "express";
import multer from "multer";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { eq, and, asc, desc, inArray, or } from "drizzle-orm";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { db, knowledgeEntriesTable, knowledgeSourcesTable, knowledgeSourceDocumentsTable, knowledgeEntrySourcesTable } from "@workspace/db";
import { z } from "zod";
import { objectStorageClient, getPrivateObjectDir, parseObjectPath } from "../lib/objectStorage";
import { requireAdmin } from "../middlewares/requireStaff";
import { checkRateLimit } from "../lib/aiGuardrails/rateLimit";
import {
  canRetryKnowledgeDocument,
  chunkExtractedText,
  applicabilityReviewBody,
  draftSourceSectionKey,
  draftOnlyUnsharedEntryIds,
  importFailurePatch,
  isRetryableTransactionAbort,
  normalizeToneRecoverySourceKey,
  planToneRecovery,
} from "../lib/knowledgeSourceImport";
import {
  enrichKnowledgeDrafts,
  MAX_TONE_RECOVERY_CANDIDATES,
  MAX_TONE_BODY_CHARS,
  previewToneRecoveryFromText,
  recoverySourceKeysForCandidates,
  type DraftCandidate,
} from "../lib/knowledgeToneRecovery";
import {
  extractedTextDigest,
  selectToneRecoveryPreviewCandidates,
  stableToneRecoveryCandidateId,
  toneRecoveryPreviewMismatch,
  type ToneRecoveryPreviewBinding,
} from "../lib/knowledgeToneRecoveryPolicy";
import {
  defaultKnowledgeGroupForCategory,
  getKnowledgeClassificationSettings,
} from "../lib/knowledgeClassification";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 15 * 1024 * 1024 } });
const ALLOWED: Record<string, string> = {
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
};
const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server")) ? path.resolve(process.cwd(), "../..") : process.cwd();

async function extract(file: Express.Multer.File): Promise<{ text: string; chunks: Array<{ title: string; body: string }> }> {
  const tmp = path.join("/tmp", `kb-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  await fs.writeFile(tmp, file.buffer);
  try {
    const child = spawn("python3", [path.join(workspaceRoot, "artifacts/api-server/python/kb_extract.py"), tmp]);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Document extraction timed out"));
      }, 30_000);
      child.on("error", reject);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c ?? 1);
      });
    });
    if (code !== 0) throw new Error(err || "document extraction failed");
    const result = JSON.parse(out) as { text?: string; chunks?: Array<{ title: string; body: string }>; error?: string };
    if (result.error || !result.text) throw new Error(result.error || "document contains no extractable text");
    // Rebuild windows from the normalized text in one place. This keeps upload
    // and retry semantics identical even when an older extractor emitted
    // over-fragmented chunks.
    const chunks = chunkExtractedText(result.text);
    if (!chunks.length) throw new Error("document contains no meaningful factual text");
    return { text: result.text, chunks };
  } finally { await fs.unlink(tmp).catch(() => undefined); }
}

function dto(row: typeof knowledgeSourcesTable.$inferSelect) {
  return { id: row.id, kind: row.kind, name: row.name, sourceUrl: row.sourceUrl, driveFolderId: row.driveFolderId, status: row.status, lastSyncAt: row.lastSyncAt, lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

async function createDrafts(
  documentId: string,
  source: typeof knowledgeSourcesTable.$inferSelect,
  chunks: Array<{ title: string; body: string }>,
  email: string,
  options: { replaceDrafts?: boolean } = {},
): Promise<{ addedDrafts: number; draftCount: number }> {
  const candidates = await enrichKnowledgeDrafts(chunks, source.name);
  // Category mapping is a future-entry/import default only. The model does
  // not select a usage group, and no existing entry is rewritten here.
  const classificationSettings = await getKnowledgeClassificationSettings();
  return db.transaction(async (tx) => {
    // Discover the current ownership without locking first. Every lock in
    // this transaction is acquired in the global order entries -> links ->
    // documents; otherwise regeneration can deadlock with bulk entry updates.
    const observedLinks = await tx
      .select({
        entryId: knowledgeEntrySourcesTable.entryId,
        sectionKey: knowledgeEntrySourcesTable.sectionKey,
        documentId: knowledgeEntrySourcesTable.documentId,
      })
      .from(knowledgeEntrySourcesTable)
      .where(eq(knowledgeEntrySourcesTable.documentId, documentId))
      .orderBy(
        asc(knowledgeEntrySourcesTable.entryId),
        asc(knowledgeEntrySourcesTable.documentId),
        asc(knowledgeEntrySourcesTable.sectionKey),
      );
    const entryIds = Array.from(new Set(observedLinks.map((entry) => entry.entryId))).sort();
    const lockedEntries = entryIds.length
      ? await tx
        .select({ id: knowledgeEntriesTable.id, reviewStatus: knowledgeEntriesTable.reviewStatus })
        .from(knowledgeEntriesTable)
        .where(inArray(knowledgeEntriesTable.id, entryIds))
        .orderBy(asc(knowledgeEntriesTable.id))
        .for("update")
      : [];
    if (lockedEntries.length !== entryIds.length) {
      throw new Error("Knowledge document links changed while drafts were being regenerated");
    }
    const lockedLinks = await tx
      .select({
        entryId: knowledgeEntrySourcesTable.entryId,
        sectionKey: knowledgeEntrySourcesTable.sectionKey,
        documentId: knowledgeEntrySourcesTable.documentId,
      })
      .from(knowledgeEntrySourcesTable)
      .where(eq(knowledgeEntrySourcesTable.documentId, documentId))
      .orderBy(
        asc(knowledgeEntrySourcesTable.entryId),
        asc(knowledgeEntrySourcesTable.documentId),
        asc(knowledgeEntrySourcesTable.sectionKey),
      )
      .for("update");
    const linkKey = (link: { entryId: string; documentId: string; sectionKey: string }) =>
      `${link.entryId}:${link.documentId}:${link.sectionKey}`;
    const observedLinkKeys = new Set(observedLinks.map(linkKey));
    const lockedLinkKeys = new Set(lockedLinks.map(linkKey));
    if (
      observedLinkKeys.size !== lockedLinkKeys.size ||
      Array.from(observedLinkKeys).some((key) => !lockedLinkKeys.has(key))
    ) {
      throw new Error("Knowledge document links changed while drafts were being regenerated");
    }
    const reviewStatuses = new Map(lockedEntries.map((entry) => [entry.id, entry.reviewStatus]));
    const existing = lockedLinks.map((link) => ({
      ...link,
      reviewStatus: reviewStatuses.get(link.entryId) ?? "",
    }));
    if (options.replaceDrafts) {
      const allLinks = entryIds.length
        ? await tx
          .select({ entryId: knowledgeEntrySourcesTable.entryId, documentId: knowledgeEntrySourcesTable.documentId })
          .from(knowledgeEntrySourcesTable)
          .where(inArray(knowledgeEntrySourcesTable.entryId, entryIds))
          .orderBy(
            asc(knowledgeEntrySourcesTable.entryId),
            asc(knowledgeEntrySourcesTable.documentId),
            asc(knowledgeEntrySourcesTable.sectionKey),
          )
          .for("update")
        : [];
    }
    // Lock the document row last. A concurrent reviewer or source worker may
    // have changed ownership while the model was running; re-read the links
    // after all locks to make the deletion decision from current ownership,
    // never from the initial snapshot.
    const lockedDocuments = await tx
      .select({ id: knowledgeSourceDocumentsTable.id })
      .from(knowledgeSourceDocumentsTable)
      .where(eq(knowledgeSourceDocumentsTable.id, documentId))
      .orderBy(asc(knowledgeSourceDocumentsTable.id))
      .for("update");
    if (!lockedDocuments.length) throw new Error("Knowledge source document no longer exists");
    const finalLinks = await tx
      .select({
        entryId: knowledgeEntrySourcesTable.entryId,
        sectionKey: knowledgeEntrySourcesTable.sectionKey,
        documentId: knowledgeEntrySourcesTable.documentId,
      })
      .from(knowledgeEntrySourcesTable)
      .where(eq(knowledgeEntrySourcesTable.documentId, documentId))
      .orderBy(
        asc(knowledgeEntrySourcesTable.entryId),
        asc(knowledgeEntrySourcesTable.documentId),
        asc(knowledgeEntrySourcesTable.sectionKey),
      );
    const finalLinkKeys = new Set(finalLinks.map(linkKey));
    if (
      finalLinkKeys.size !== lockedLinkKeys.size ||
      Array.from(finalLinkKeys).some((key) => !lockedLinkKeys.has(key))
    ) {
      throw new Error("Knowledge document links changed while drafts were being regenerated");
    }
    const finalOwnershipLinks = entryIds.length
      ? await tx
        .select({
          entryId: knowledgeEntrySourcesTable.entryId,
          documentId: knowledgeEntrySourcesTable.documentId,
        })
        .from(knowledgeEntrySourcesTable)
        .where(inArray(knowledgeEntrySourcesTable.entryId, entryIds))
        .orderBy(
          asc(knowledgeEntrySourcesTable.entryId),
          asc(knowledgeEntrySourcesTable.documentId),
          asc(knowledgeEntrySourcesTable.sectionKey),
        )
      : [];
    if (options.replaceDrafts) {
      if (lockedEntries.some((entry) => entry.reviewStatus === "approved")) {
        throw new Error("A linked knowledge entry was approved while this document was being regenerated");
      }
      const removableEntryIds = draftOnlyUnsharedEntryIds(existing, finalOwnershipLinks, documentId);
      if (removableEntryIds.length) {
        await tx
          .delete(knowledgeEntrySourcesTable)
          .where(
            and(
              eq(knowledgeEntrySourcesTable.documentId, documentId),
              inArray(knowledgeEntrySourcesTable.entryId, removableEntryIds),
            ),
          );
        await tx
          .delete(knowledgeEntriesTable)
          .where(
            and(
              inArray(knowledgeEntriesTable.id, removableEntryIds),
              eq(knowledgeEntriesTable.reviewStatus, "draft"),
            ),
          );
      }
    }

    const remaining = await tx
      .select({ entryId: knowledgeEntrySourcesTable.entryId, sectionKey: knowledgeEntrySourcesTable.sectionKey })
      .from(knowledgeEntrySourcesTable)
      .where(eq(knowledgeEntrySourcesTable.documentId, documentId));
    // Existing source keys make a normal import idempotent. Do not add keys
    // from newly inserted candidates here: two semantic topics may correctly
    // cite the same bounded source window.
    const existingSectionKeys = new Set(
      remaining.map((entry) => normalizeToneRecoverySourceKey(entry.sectionKey)),
    );
    const toneCandidates = candidates.filter((candidate) => candidate.candidateType === "tone");
    const toneKeysByCandidate = recoverySourceKeysForCandidates(toneCandidates, chunks);
    let toneCandidateIndex = 0;
    let addedDrafts = 0;
    for (const candidate of candidates) {
      const requiresApplicabilityReview =
        candidate.dateBound &&
        !candidate.effectiveDate &&
        !candidate.expiresDate;
      // Hash deterministic source sections, never model-generated text. This
      // keeps normal imports idempotent even if the model rephrases a title.
      const sections = candidate.sourceIndexes
        .map((index) => chunks[index])
        .filter((section): section is { title: string; body: string } => Boolean(section));
      if (!sections.length) throw new Error("AI draft extraction referenced a missing source window");
      const keys = candidate.candidateType === "tone"
        ? (toneKeysByCandidate[toneCandidateIndex++] ?? [])
        : sections.map((section) => draftSourceSectionKey(section, candidate.candidateType));
      if (!keys.length) throw new Error("AI tone extraction returned no source provenance");
      // Regeneration must still create replacement candidates when a
      // protected shared draft cites the same window. Normal imports retain
      // key-based idempotence; replacement has already removed all removable
      // drafts transactionally and must not let a shared row suppress output.
      if (!options.replaceDrafts && keys.every((key) => existingSectionKeys.has(key))) continue;
      const isToneCandidate = candidate.candidateType === "tone";
      const [entry] = await tx.insert(knowledgeEntriesTable).values({
        title: candidate.title || source.name,
        body: requiresApplicabilityReview
          ? applicabilityReviewBody(candidate.body)
          : candidate.body,
        // Tone guidance is explicitly separated from facts. Facts retain the
        // existing category-default policy; the model cannot widen customer
        // sharing by selecting a group.
        category: isToneCandidate ? "general" : candidate.category,
        knowledgeGroup: requiresApplicabilityReview
          ? "internal_operational"
          : isToneCandidate
          ? "brand_voice"
          : defaultKnowledgeGroupForCategory(candidate.category, classificationSettings),
        tags: Array.from(
          new Set([
            ...candidate.tags.map((tag) => tag.toLowerCase()),
            ...(requiresApplicabilityReview ? ["applicability-review"] : []),
          ]),
        ),
        sourceName: source.name, sourceUrl: source.sourceUrl, reviewStatus: "draft",
        effectiveDate: candidate.effectiveDate,
        expiresDate: candidate.expiresDate,
        createdByEmail: email, updatedByEmail: email,
      }).returning();
      if (!entry) throw new Error("Knowledge draft insert returned no entry");
      for (const key of keys) {
        await tx.insert(knowledgeEntrySourcesTable).values({ entryId: entry.id, documentId, sectionKey: key });
      }
      addedDrafts++;
    }
    const draftLinks = await tx
      .select({
        entryId: knowledgeEntrySourcesTable.entryId,
        reviewStatus: knowledgeEntriesTable.reviewStatus,
      })
      .from(knowledgeEntrySourcesTable)
      .innerJoin(
        knowledgeEntriesTable,
        eq(knowledgeEntriesTable.id, knowledgeEntrySourcesTable.entryId),
      )
      .where(eq(knowledgeEntrySourcesTable.documentId, documentId));
    const draftEntryIds = new Set(
      draftLinks
        .filter((entry) => entry.reviewStatus === "draft")
        .map((entry) => entry.entryId),
    );
    return {
      addedDrafts,
      draftCount: draftEntryIds.size,
    };
  });
}

export class KnowledgeDocumentError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "KnowledgeDocumentError";
  }
}

const retryInFlight = new Set<string>();
const toneRecoveryInFlight = new Set<string>();
const toneRecoveryPreviews = new Map<
  string,
  ToneRecoveryPreviewBinding & {
    candidates: Array<DraftCandidate & { candidateId: string; sourceKeys: string[] }>;
  }
>();
const TONE_RECOVERY_PREVIEW_TTL_MS = 10 * 60_000;
const TONE_RECOVERY_RATE_LIMIT_PER_MINUTE = 5;

const ToneRecoveryPreviewRequestSchema = z.object({
  // Kept as a body schema even though the document id is the primary input so
  // future clients cannot accidentally send an unbounded extraction request.
  confirmStoredText: z.literal(true),
});
const ToneRecoveryCommitRequestSchema = z.object({
  token: z.string().uuid(),
  candidateIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(MAX_TONE_RECOVERY_CANDIDATES),
});

function cleanupToneRecoveryPreviews(now = Date.now()): void {
  for (const [token, preview] of toneRecoveryPreviews) {
    if (preview.expiresAt <= now) toneRecoveryPreviews.delete(token);
  }
  while (toneRecoveryPreviews.size > 500) {
    const oldest = toneRecoveryPreviews.keys().next().value;
    if (!oldest) break;
    toneRecoveryPreviews.delete(oldest);
  }
}

async function eligibleToneRecoveryDocument(documentId: string): Promise<{
  document: typeof knowledgeSourceDocumentsTable.$inferSelect;
  source: typeof knowledgeSourcesTable.$inferSelect;
}> {
  const [document] = await db
    .select()
    .from(knowledgeSourceDocumentsTable)
    .where(eq(knowledgeSourceDocumentsTable.id, documentId))
    .limit(1);
  if (!document) throw new KnowledgeDocumentError("Knowledge document not found", 404);
  const [source] = await db
    .select()
    .from(knowledgeSourcesTable)
    .where(eq(knowledgeSourcesTable.id, document.sourceId))
    .limit(1);
  if (!source) throw new KnowledgeDocumentError("The document's source no longer exists", 409);
  if (source.kind !== "upload") {
    throw new KnowledgeDocumentError("Tone recovery is available for uploaded documents only", 409);
  }
  if (source.status !== "active" || document.status !== "active") {
    throw new KnowledgeDocumentError("Tone recovery requires an active source and active document", 409);
  }
  if (!document.extractedText.trim()) {
    throw new KnowledgeDocumentError("No stored extracted text is available for tone recovery", 422);
  }
  return { document, source };
}

async function markImportFailed(
  documentId: string,
  sourceId: string,
  error: unknown,
  email: string,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const patch = importFailurePatch(message, email);
  await db.transaction(async (tx) => {
    // Do not include extractedText in this patch: source text is retained for
    // the staff preview and for a later retry.
    await tx
      .update(knowledgeSourceDocumentsTable)
      .set(patch)
      .where(eq(knowledgeSourceDocumentsTable.id, documentId));
    await tx
      .update(knowledgeSourcesTable)
      .set({
        status: "error",
        lastError: message,
        updatedByEmail: email,
        updatedAt: patch.updatedAt,
      })
      .where(
        and(
          eq(knowledgeSourcesTable.id, sourceId),
          inArray(knowledgeSourcesTable.status, ["active", "error", "processing", "syncing", "paused"]),
        ),
      );
  });
}

async function restoreDocumentClaim(
  documentId: string,
  previousStatus: string,
  previousError: string | null,
  email: string,
): Promise<void> {
  const status = ["error", "active", "stale"].includes(previousStatus) ? previousStatus : "error";
  await db
    .update(knowledgeSourceDocumentsTable)
    .set({
      status,
      lastError: previousError,
      updatedByEmail: email,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeSourceDocumentsTable.id, documentId),
        eq(knowledgeSourceDocumentsTable.status, "processing"),
      ),
    );
}

/**
 * A newly uploaded document starts in processing, but its owning source is
 * already active. If the enrichment transaction is aborted by PostgreSQL's
 * deadlock/serialization detector, leave the source active and make the
 * document retryable instead of reporting a source ingestion failure.
 */
async function restoreTransientUpload(
  documentId: string,
  error: unknown,
  email: string,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(knowledgeSourceDocumentsTable)
    .set({
      status: "error",
      lastError: message,
      updatedByEmail: email,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeSourceDocumentsTable.id, documentId),
        eq(knowledgeSourceDocumentsTable.status, "processing"),
      ),
    );
}

async function markImportSucceeded(
  documentId: string,
  sourceId: string,
  draftCount: number,
  email: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(knowledgeSourceDocumentsTable)
      .set({
        status: "active",
        draftCount,
        lastError: null,
        updatedByEmail: email,
        updatedAt: now,
      })
      .where(eq(knowledgeSourceDocumentsTable.id, documentId));
    // A failed import marks its owning source as error. Only recover that
    // state; a paused/deleted source must not be silently re-enabled.
    await tx
      .update(knowledgeSourcesTable)
      .set({ status: "active", lastError: null, updatedByEmail: email, updatedAt: now })
      .where(and(eq(knowledgeSourcesTable.id, sourceId), eq(knowledgeSourcesTable.status, "error")));
  });
}

/**
 * Retry service used by the admin endpoint and by one-off dev recovery
 * harnesses. It deliberately accepts only a document id and staff email, so a
 * harness can call the same guarded operation without an auth bypass route.
 */
export async function retryKnowledgeDocument(
  documentId: string,
  email: string,
): Promise<{ draftCount: number }> {
  if (retryInFlight.has(documentId)) {
    throw new KnowledgeDocumentError("A retry for this document is already in progress", 409);
  }
  retryInFlight.add(documentId);

  let claimed: typeof knowledgeSourceDocumentsTable.$inferSelect | undefined;
  let claimRestore:
    | { status: string; lastError: string | null }
    | undefined;
  try {
    claimed = await db.transaction(async (tx) => {
      const [document] = await tx
        .select()
        .from(knowledgeSourceDocumentsTable)
        .where(eq(knowledgeSourceDocumentsTable.id, documentId))
        .limit(1);
      if (!document) throw new KnowledgeDocumentError("Knowledge document not found", 404);

      const linked = await tx
        .select({ reviewStatus: knowledgeEntriesTable.reviewStatus })
        .from(knowledgeEntrySourcesTable)
        .innerJoin(
          knowledgeEntriesTable,
          eq(knowledgeEntriesTable.id, knowledgeEntrySourcesTable.entryId),
        )
        .where(eq(knowledgeEntrySourcesTable.documentId, documentId));
      const hasApprovedEntries = linked.some((entry) => entry.reviewStatus === "approved");
      if (hasApprovedEntries) {
        throw new KnowledgeDocumentError(
          "This document already has approved knowledge entries; retry is refused so approvals are not reset",
          409,
        );
      }
      if (!canRetryKnowledgeDocument(document, false)) {
        if (document.status === "processing") {
          throw new KnowledgeDocumentError("This document is already being imported", 409);
        }
        throw new KnowledgeDocumentError(
          "Retry is available only for failed or unapproved document imports",
          409,
        );
      }
      claimRestore = { status: document.status, lastError: document.lastError };

      // The conditional update is the database-side concurrency guard. The
      // in-process set above also gives an immediate actionable response.
      const [updated] = await tx
        .update(knowledgeSourceDocumentsTable)
        .set({
          status: "processing",
          lastError: null,
          updatedByEmail: email,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledgeSourceDocumentsTable.id, documentId),
            or(
              eq(knowledgeSourceDocumentsTable.status, "error"),
              inArray(knowledgeSourceDocumentsTable.status, ["active", "stale"]),
            ),
          ),
        )
        .returning();
      if (!updated) {
        throw new KnowledgeDocumentError("This document changed; retry it again after the current import finishes", 409);
      }
      return updated;
    });

    const [source] = await db
      .select()
      .from(knowledgeSourcesTable)
      .where(eq(knowledgeSourcesTable.id, claimed.sourceId))
      .limit(1);
    if (!source) throw new KnowledgeDocumentError("The document's owning source no longer exists", 409);
    if (source.status === "deleted") {
      throw new KnowledgeDocumentError("The document's source has been deleted; upload it again", 409);
    }
    if (!claimed.extractedText.trim()) {
      throw new KnowledgeDocumentError(
        "No extracted text is available to retry; upload the original document again",
        422,
      );
    }
    const chunks = chunkExtractedText(claimed.extractedText);
    if (!chunks.length) {
      throw new KnowledgeDocumentError(
        "Stored extracted text contains no usable sections; upload the original document again",
        422,
      );
    }

    const regenerated = await createDrafts(claimed.id, source, chunks, email, { replaceDrafts: true });
    await markImportSucceeded(claimed.id, source.id, regenerated.draftCount, email);
    return { draftCount: regenerated.draftCount };
  } catch (error) {
    if (claimed) {
      if (isRetryableTransactionAbort(error) && claimRestore) {
        await restoreDocumentClaim(claimed.id, claimRestore.status, claimRestore.lastError, email);
      } else {
        await markImportFailed(claimed.id, claimed.sourceId, error, email);
      }
    }
    throw error;
  } finally {
    retryInFlight.delete(documentId);
  }
}

async function driveProxy(endpoint: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<any> {
  const response = await new ReplitConnectors().proxy("google-drive", endpoint, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`Google Drive returned ${response.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

function driveUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

async function listDriveDescendants(folderId: string): Promise<any[]> {
  const out: any[] = [];
  const visitedFolders = new Set<string>();
  const visit = async (parent: string) => {
    if (visitedFolders.has(parent)) return;
    visitedFolders.add(parent);
    let token = "";
    do {
      const query = new URLSearchParams({
        q: `'${parent}' in parents and trashed = false`,
        pageSize: "1000",
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,version,webViewLink,md5Checksum,size,driveId)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (token) query.set("pageToken", token);
      const page = await driveProxy(`/drive/v3/files?${query}`);
      for (const file of page.files ?? []) {
        if (file.mimeType === "application/vnd.google-apps.folder") await visit(file.id);
        else out.push(file);
      }
      token = page.nextPageToken ?? "";
    } while (token);
  };
  await visit(folderId);
  return out;
}

async function downloadDriveFile(file: any): Promise<{ bytes: Buffer; mimeType: string }> {
  const exportMap: Record<string, [string, string]> = {
    "application/vnd.google-apps.document": ["text/plain", "text/plain"],
    "application/vnd.google-apps.spreadsheet": ["text/csv", "text/csv"],
  };
  const exp = exportMap[file.mimeType];
  const query = exp ? `mimeType=${encodeURIComponent(exp[0])}` : "";
  const endpoint = exp ? `/drive/v3/files/${file.id}/export?${query}` : `/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
  const response = await new ReplitConnectors().proxy("google-drive", endpoint, { headers: { Accept: exp?.[1] ?? file.mimeType } });
  if (!response.ok) throw new Error(`Drive download failed (${response.status})`);
  return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: exp?.[1] ?? file.mimeType };
}

export async function syncDriveSource(source: typeof knowledgeSourcesTable.$inferSelect, email: string): Promise<{ documents: number; drafts: number }> {
  const files = await listDriveDescendants(source.driveFolderId!);
  const seen = new Set<string>();
  let drafts = 0;
  for (const file of files) {
    const ext = file.name?.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
    const supported = [".pdf", ".docx", ".txt", ".md", ".csv"].includes(ext) ||
      file.mimeType === "application/vnd.google-apps.document" || file.mimeType === "application/vnd.google-apps.spreadsheet";
    if (!supported) continue;
    seen.add(file.id);
    const [old] = await db.select().from(knowledgeSourceDocumentsTable).where(and(eq(knowledgeSourceDocumentsTable.sourceId, source.id), eq(knowledgeSourceDocumentsTable.externalFileId, file.id))).limit(1);
    if (old && old.driveRevision === String(file.version ?? "") && old.driveModifiedTime?.getTime() === new Date(file.modifiedTime).getTime()) continue;
    const downloaded = await downloadDriveFile(file);
    if (downloaded.bytes.length > 15 * 1024 * 1024) {
      throw new Error(`Drive file "${file.name}" exceeds the 15 MB import limit`);
    }
    const checksum = createHash("sha256").update(downloaded.bytes).digest("hex");
    if (old && old.checksum === checksum) {
      await db.update(knowledgeSourceDocumentsTable).set({ driveRevision: String(file.version ?? ""), driveModifiedTime: new Date(file.modifiedTime), status: "active", updatedAt: new Date() }).where(eq(knowledgeSourceDocumentsTable.id, old.id));
      continue;
    }
    const extractionName =
      file.mimeType === "application/vnd.google-apps.document"
        ? `${file.name}.txt`
        : file.mimeType === "application/vnd.google-apps.spreadsheet"
          ? `${file.name}.csv`
          : file.name;
    const tempFile = { originalname: extractionName, buffer: downloaded.bytes, mimetype: downloaded.mimeType } as Express.Multer.File;
    const extracted = await extract(tempFile);
    const doc = old ?? (await db.insert(knowledgeSourceDocumentsTable).values({
      sourceId: source.id, externalFileId: file.id, name: file.name, mimeType: downloaded.mimeType,
      checksum, extractedText: extracted.text, status: "active", driveRevision: String(file.version ?? ""),
      driveModifiedTime: new Date(file.modifiedTime), createdByEmail: email, updatedByEmail: email,
    }).returning())[0]!;
    if (old) {
      await db.update(knowledgeSourceDocumentsTable).set({ checksum, extractedText: extracted.text, name: file.name, mimeType: downloaded.mimeType, driveRevision: String(file.version ?? ""), driveModifiedTime: new Date(file.modifiedTime), status: "active", updatedAt: new Date(), updatedByEmail: email }).where(eq(knowledgeSourceDocumentsTable.id, old.id));
      await db.update(knowledgeEntrySourcesTable).set({ stale: "true" }).where(eq(knowledgeEntrySourcesTable.documentId, old.id));
    }
    const documentDrafts = await createDrafts(doc.id, source, extracted.chunks, email);
    drafts += documentDrafts.addedDrafts;
    await db.update(knowledgeSourceDocumentsTable).set({ draftCount: documentDrafts.draftCount, updatedAt: new Date() }).where(eq(knowledgeSourceDocumentsTable.id, doc.id));
  }
  const docs = await db.select().from(knowledgeSourceDocumentsTable).where(eq(knowledgeSourceDocumentsTable.sourceId, source.id));
  for (const doc of docs) if (doc.externalFileId && !seen.has(doc.externalFileId)) {
    await db.update(knowledgeSourceDocumentsTable).set({ status: "deleted", updatedAt: new Date() }).where(eq(knowledgeSourceDocumentsTable.id, doc.id));
    await db.update(knowledgeEntrySourcesTable).set({ stale: "true" }).where(eq(knowledgeEntrySourcesTable.documentId, doc.id));
  }
  return { documents: seen.size, drafts };
}

export async function runDriveSourceSync(sourceId: string, email: string): Promise<{ documents: number; drafts: number }> {
  const [claimed] = await db
    .update(knowledgeSourcesTable)
    .set({ status: "syncing", lastError: null, updatedAt: new Date(), updatedByEmail: email })
    .where(
      and(
        eq(knowledgeSourcesTable.id, sourceId),
        inArray(knowledgeSourcesTable.status, ["active", "error"]),
      ),
    )
    .returning();
  if (!claimed) {
    throw new Error("Source is paused, deleted, or already syncing");
  }
  try {
    const result = await syncDriveSource(claimed, email);
    await db
      .update(knowledgeSourcesTable)
      .set({ status: "active", lastSyncAt: new Date(), lastError: null, updatedAt: new Date(), updatedByEmail: email })
      .where(eq(knowledgeSourcesTable.id, sourceId));
    return result;
  } catch (error) {
    if (isRetryableTransactionAbort(error)) {
      await db
        .update(knowledgeSourcesTable)
        .set({
          status: claimed.status,
          lastError: claimed.lastError,
          updatedAt: new Date(),
          updatedByEmail: email,
        })
        .where(
          and(
            eq(knowledgeSourcesTable.id, sourceId),
            eq(knowledgeSourcesTable.status, "syncing"),
          ),
        );
      throw error;
    }
    await db
      .update(knowledgeSourcesTable)
      .set({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
        updatedByEmail: email,
      })
      .where(eq(knowledgeSourcesTable.id, sourceId));
    throw error;
  }
}

router.post("/knowledge/sources/upload", upload.single("file"), async (req, res): Promise<void> => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "Exactly one file is required" }); return; }
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED[ext]) { res.status(415).json({ error: "Only PDF, DOCX, TXT, MD, and CSV files are allowed" }); return; }
  const checksum = createHash("sha256").update(file.buffer).digest("hex");
  const existing = await db.select({ id: knowledgeSourceDocumentsTable.id }).from(knowledgeSourceDocumentsTable).where(eq(knowledgeSourceDocumentsTable.checksum, checksum)).limit(1);
  if (existing[0]) {
    const [document] = await db.select().from(knowledgeSourceDocumentsTable).where(eq(knowledgeSourceDocumentsTable.id, existing[0].id));
    res.status(200).json({ documentId: existing[0].id, draftCount: document?.draftCount ?? 0, idempotent: true });
    return;
  }
  const source = (await db.insert(knowledgeSourcesTable).values({
    kind: "upload", name: req.body?.name || file.originalname, sourceUrl: req.body?.sourceUrl || "",
    status: "active", createdByEmail: req.staff!.email, updatedByEmail: req.staff!.email,
  }).returning())[0]!;
  const objectPath = `${getPrivateObjectDir()}/knowledge/${source.id}/${checksum}${ext}`;
  const parsed = parseObjectPath(objectPath);
  let document: typeof knowledgeSourceDocumentsTable.$inferSelect | undefined;
  try {
    // Create one processing row before any work that can fail. Every later
    // error updates this same row, rather than creating an active row plus a
    // second error row.
    document = (await db.insert(knowledgeSourceDocumentsTable).values({
      sourceId: source.id,
      name: file.originalname,
      mimeType: file.mimetype,
      checksum,
      objectPath,
      status: "processing",
      createdByEmail: req.staff!.email,
      updatedByEmail: req.staff!.email,
    }).returning())[0]!;
    await objectStorageClient.bucket(parsed.bucketName).file(parsed.objectName).save(file.buffer, { resumable: false, contentType: file.mimetype });
    const extracted = await extract(file);
    // Persist extracted text before LLM enrichment. If enrichment fails, the
    // staff preview and retry endpoint still have the original material.
    await db.update(knowledgeSourceDocumentsTable).set({
      extractedText: extracted.text,
      updatedAt: new Date(),
      updatedByEmail: req.staff!.email,
    }).where(eq(knowledgeSourceDocumentsTable.id, document.id));
    const created = await createDrafts(document.id, source, extracted.chunks, req.staff!.email);
    await markImportSucceeded(document.id, source.id, created.draftCount, req.staff!.email);
    const [updatedSource] = await db.select().from(knowledgeSourcesTable).where(eq(knowledgeSourcesTable.id, source.id)).limit(1);
    res.status(201).json({ source: dto(updatedSource ?? source), documentId: document.id, draftCount: created.draftCount });
  } catch (error) {
    if (document) {
      if (isRetryableTransactionAbort(error)) {
        await restoreTransientUpload(document.id, error, req.staff!.email);
      } else {
        await markImportFailed(document.id, source.id, error, req.staff!.email);
      }
    } else {
      await db.update(knowledgeSourcesTable).set({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
        updatedByEmail: req.staff!.email,
        updatedAt: new Date(),
      }).where(eq(knowledgeSourcesTable.id, source.id));
    }
    res.status(422).json({ error: error instanceof Error ? error.message : "Extraction failed" });
  }
});

router.get("/knowledge/documents/:id/preview", requireAdmin, async (req, res): Promise<void> => {
  const documentId = String(req.params.id);
  if (!z.string().uuid().safeParse(documentId).success) {
    res.status(400).json({ error: "A valid knowledge document id is required" });
    return;
  }
  const [document] = await db
    .select()
    .from(knowledgeSourceDocumentsTable)
    .where(eq(knowledgeSourceDocumentsTable.id, documentId))
    .limit(1);
  if (!document) {
    res.status(404).json({ error: "Knowledge document not found" });
    return;
  }
  // This is an admin-only staff preview. In particular, objectPath and source
  // storage details never leave this route.
  res.json({
    id: document.id,
    name: document.name,
    status: document.status,
    text: document.extractedText,
    draftCount: document.draftCount,
    error: document.lastError,
  });
});

/**
 * Non-persisting voice/lexicon recovery. It reads only the stored extracted
 * text and holds model output in a short-lived staff-scoped preview token.
 * Saving is a separate, explicitly selected operation below.
 */
router.post("/knowledge/documents/:id/tone-recovery/preview", requireAdmin, async (req, res): Promise<void> => {
  const documentId = String(req.params.id);
  if (!z.string().uuid().safeParse(documentId).success) {
    res.status(400).json({ error: "A valid knowledge document id is required" });
    return;
  }
  const parsedBody = ToneRecoveryPreviewRequestSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const staffKey = `knowledge-tone-recovery:${req.staff!.id}`;
  const rate = checkRateLimit(staffKey, TONE_RECOVERY_RATE_LIMIT_PER_MINUTE);
  if (!rate.allowed) {
    res
      .status(429)
      .set("Retry-After", String(rate.retryAfterSeconds))
      .json({ error: "Tone recovery rate limit reached. Try again shortly." });
    return;
  }
  if (toneRecoveryInFlight.has(staffKey)) {
    res
      .status(429)
      .set("Retry-After", "1")
      .json({ error: "A tone recovery preview is already in progress." });
    return;
  }

  toneRecoveryInFlight.add(staffKey);
  try {
    cleanupToneRecoveryPreviews();
    const { document, source } = await eligibleToneRecoveryDocument(documentId);
    const preview = await previewToneRecoveryFromText(document.extractedText, source.name);
    const sourceKeysByCandidate = recoverySourceKeysForCandidates(preview.candidates, preview.chunks);
    const candidates = preview.candidates.map((candidate, candidateIndex) => {
      const sourceKeys = sourceKeysByCandidate[candidateIndex] ?? [];
      if (!sourceKeys.length) {
        throw new Error("Tone recovery returned a candidate without a source link");
      }
      const candidateId = stableToneRecoveryCandidateId(sourceKeys);
      return { ...candidate, candidateId, sourceKeys };
    });
    const deduplicatedCandidates = Array.from(
      new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values(),
    );
    const token = randomUUID();
    toneRecoveryPreviews.set(token, {
      staffId: req.staff!.id,
      documentId,
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt.toISOString(),
      documentChecksum: document.checksum,
      extractedTextDigest: extractedTextDigest(document.extractedText),
      expiresAt: Date.now() + TONE_RECOVERY_PREVIEW_TTL_MS,
      candidates: deduplicatedCandidates,
    });
    res.json({
      token,
      documentId,
      sourceName: source.name,
      sourceUrl: source.sourceUrl,
      candidates: deduplicatedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        candidateType: "tone" as const,
        title: candidate.title,
        body: candidate.body,
        category: "general" as const,
        tags: candidate.tags,
        sourceIndexes: candidate.sourceIndexes,
         effectiveDate: candidate.effectiveDate,
         expiresDate: candidate.expiresDate,
         dateBound: candidate.dateBound,
         dateNote: candidate.dateNote,
      })),
       excludedDateBound: preview.excludedDateBound.map((candidate) => ({
         title: candidate.title,
         body: candidate.body,
         dateNote: candidate.dateNote,
       })),
      assessment: {
        candidateCount: deduplicatedCandidates.length,
        retrievalCap: 3,
         toneBodyCharacterLimit: MAX_TONE_BODY_CHARS,
        mayExceedRetrievalCap: deduplicatedCandidates.length > 3,
        message:
          deduplicatedCandidates.length > 3
            ? "Existing Brand/Voice retrieval currently caps at 3 entries. All recovery candidates are shown for review; this action does not discard or auto-approve the additional guidance."
             : "Review each candidate before saving. Brand/Voice guidance controls wording only, not facts or policy promises. Recovery identity is the source-section hash plus ordered topic slot; a model cannot always reconstruct a topic if same-window topics are reordered.",
      },
    });
  } catch (error) {
    if (error instanceof KnowledgeDocumentError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    req.log.error({ err: error, documentId }, "tone recovery preview failed");
    res.status(422).json({ error: error instanceof Error ? error.message : "Tone recovery preview failed" });
  } finally {
    toneRecoveryInFlight.delete(staffKey);
  }
});

router.post("/knowledge/documents/:id/tone-recovery/commit", requireAdmin, async (req, res): Promise<void> => {
  const documentId = String(req.params.id);
  if (!z.string().uuid().safeParse(documentId).success) {
    res.status(400).json({ error: "A valid knowledge document id is required" });
    return;
  }
  const parsed = ToneRecoveryCommitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (new Set(parsed.data.candidateIds).size !== parsed.data.candidateIds.length) {
    res.status(400).json({ error: "Candidate ids must be unique" });
    return;
  }
  cleanupToneRecoveryPreviews();
  const preview = toneRecoveryPreviews.get(parsed.data.token);
  if (!preview) {
    res.status(409).json({ error: "This tone recovery preview is expired or belongs to another document or staff session. Preview again." });
    return;
  }
  const staffKey = `knowledge-tone-recovery:${req.staff!.id}`;
  if (toneRecoveryInFlight.has(staffKey)) {
    res.status(429).set("Retry-After", "1").json({ error: "A tone recovery operation is already in progress." });
    return;
  }
  toneRecoveryInFlight.add(staffKey);
  // Consume the preview before the transaction. A failed save is surfaced and
  // can be retried with a fresh, bounded preview; this prevents token replay.
  toneRecoveryPreviews.delete(parsed.data.token);
  try {
    const result = await db.transaction(async (tx) => {
      // Match the existing source-import lock order: linked entries, document,
      // then source. This protects a concurrent approval while preserving the
      // source's active/deleted state check before any insert.
      const linkedRows = await tx
        .select({
          entryId: knowledgeEntrySourcesTable.entryId,
          documentId: knowledgeEntrySourcesTable.documentId,
          sectionKey: knowledgeEntrySourcesTable.sectionKey,
          title: knowledgeEntriesTable.title,
          body: knowledgeEntriesTable.body,
          category: knowledgeEntriesTable.category,
          knowledgeGroup: knowledgeEntriesTable.knowledgeGroup,
          tags: knowledgeEntriesTable.tags,
          reviewStatus: knowledgeEntriesTable.reviewStatus,
        })
        .from(knowledgeEntrySourcesTable)
        .innerJoin(
          knowledgeEntriesTable,
          eq(knowledgeEntriesTable.id, knowledgeEntrySourcesTable.entryId),
        )
        .where(eq(knowledgeEntrySourcesTable.documentId, documentId))
        .orderBy(asc(knowledgeEntrySourcesTable.entryId), asc(knowledgeEntrySourcesTable.sectionKey))
        .for("update");
      await tx
        .select({ id: knowledgeSourceDocumentsTable.id })
        .from(knowledgeSourceDocumentsTable)
        .where(eq(knowledgeSourceDocumentsTable.id, documentId))
        .for("update");
      const [source] = await tx
        .select()
        .from(knowledgeSourcesTable)
        .where(eq(knowledgeSourcesTable.id, preview.sourceId))
        .for("update");
      const [document] = await tx
        .select()
        .from(knowledgeSourceDocumentsTable)
        .where(eq(knowledgeSourceDocumentsTable.id, documentId))
        .limit(1);
      if (!source || source.kind !== "upload" || source.status !== "active" || !document || document.status !== "active" || document.sourceId !== source.id) {
        throw new KnowledgeDocumentError("Tone recovery requires an active source and active document", 409);
      }
      const previewMismatch = toneRecoveryPreviewMismatch(preview, {
        staffId: req.staff!.id,
        documentId,
        sourceId: source.id,
        sourceUpdatedAt: source.updatedAt.toISOString(),
        documentChecksum: document.checksum,
        extractedTextDigest: extractedTextDigest(document.extractedText),
      });
      if (previewMismatch) {
        throw new KnowledgeDocumentError(`Tone recovery preview is stale: ${previewMismatch}. Preview again.`, 409);
      }
      const selection = selectToneRecoveryPreviewCandidates(
        preview,
        parsed.data.candidateIds,
        {
          staffId: req.staff!.id,
          documentId,
          sourceId: source.id,
          sourceUpdatedAt: source.updatedAt.toISOString(),
          documentChecksum: document.checksum,
          extractedTextDigest: extractedTextDigest(document.extractedText),
        },
      );
      if (selection.error) {
        throw new KnowledgeDocumentError(`${selection.error}. Preview again.`, 409);
      }
      const selectedIds = new Set(parsed.data.candidateIds);
      const candidates = preview.candidates.filter((candidate) =>
        selectedIds.has(candidate.candidateId),
      ) as Array<DraftCandidate & { candidateId: string; sourceKeys: string[] }>;
      if (candidates.length !== parsed.data.candidateIds.length) {
        throw new KnowledgeDocumentError("One or more recovery candidates are not in the preview. Preview again.", 409);
      }
      // A second recovery request may have read the old link set before it
      // waited on the document lock. Re-read after the lock so dedupe observes
      // a just-committed candidate rather than inserting a duplicate.
      const refreshedLinkedRows = await tx
        .select({
          entryId: knowledgeEntrySourcesTable.entryId,
          documentId: knowledgeEntrySourcesTable.documentId,
          sectionKey: knowledgeEntrySourcesTable.sectionKey,
          title: knowledgeEntriesTable.title,
          body: knowledgeEntriesTable.body,
          category: knowledgeEntriesTable.category,
          knowledgeGroup: knowledgeEntriesTable.knowledgeGroup,
          tags: knowledgeEntriesTable.tags,
          reviewStatus: knowledgeEntriesTable.reviewStatus,
        })
        .from(knowledgeEntrySourcesTable)
        .innerJoin(
          knowledgeEntriesTable,
          eq(knowledgeEntriesTable.id, knowledgeEntrySourcesTable.entryId),
        )
        .where(eq(knowledgeEntrySourcesTable.documentId, documentId))
        .orderBy(asc(knowledgeEntrySourcesTable.entryId), asc(knowledgeEntrySourcesTable.sectionKey))
        .for("update");

      const byEntry = new Map<
        string,
        {
          entryId: string;
          title: string;
          body: string;
          category: string;
          knowledgeGroup: string;
          tags: string[];
          reviewStatus: string;
          sourceKeys: string[];
        }
      >();
      for (const row of refreshedLinkedRows) {
        const current = byEntry.get(row.entryId);
        if (current) {
           current.sourceKeys.push(normalizeToneRecoverySourceKey(row.sectionKey));
        } else {
          byEntry.set(row.entryId, {
            entryId: row.entryId,
            title: row.title,
            body: row.body,
            category: row.category,
            knowledgeGroup: row.knowledgeGroup,
            tags: row.tags,
            reviewStatus: row.reviewStatus,
             sourceKeys: [normalizeToneRecoverySourceKey(row.sectionKey)],
          });
        }
      }
      const plan = planToneRecovery(
        candidates.map((candidate) => ({
          title: candidate.title,
          body: candidate.body,
          tags: candidate.tags,
          sourceKeys: candidate.sourceKeys,
           effectiveDate: candidate.effectiveDate,
           expiresDate: candidate.expiresDate,
           dateBound: candidate.dateBound,
        })),
        Array.from(byEntry.values())
          .filter((entry) => entry.knowledgeGroup === "brand_voice")
          .map((entry) => ({
            title: entry.title,
            body: entry.body,
            tags: entry.tags,
            sourceKeys: entry.sourceKeys,
            entryId: entry.entryId,
            reviewStatus: entry.reviewStatus,
          })),
      );

      for (const candidate of plan.toInsert) {
        const [entry] = await tx
          .insert(knowledgeEntriesTable)
          .values({
            title: candidate.title,
            body: candidate.body,
            category: "general",
            knowledgeGroup: "brand_voice",
            tags: Array.from(new Set(candidate.tags.map((tag) => tag.toLowerCase()))),
            sourceName: source.name,
            sourceUrl: source.sourceUrl,
            effectiveDate: candidate.effectiveDate ?? null,
            expiresDate: candidate.expiresDate ?? null,
            reviewStatus: "draft",
            createdByEmail: req.staff!.email,
            updatedByEmail: req.staff!.email,
          })
          .returning();
        if (!entry) throw new Error("Tone recovery draft insert returned no entry");
        await tx
          .insert(knowledgeEntrySourcesTable)
          .values(
            candidate.sourceKeys.map((sectionKey) => ({
              entryId: entry.id,
              documentId,
              sectionKey,
            })),
          )
          .onConflictDoNothing();
      }

      const draftLinks = await tx
        .select({ entryId: knowledgeEntrySourcesTable.entryId })
        .from(knowledgeEntrySourcesTable)
        .innerJoin(
          knowledgeEntriesTable,
          eq(knowledgeEntriesTable.id, knowledgeEntrySourcesTable.entryId),
        )
        .where(and(eq(knowledgeEntrySourcesTable.documentId, documentId), eq(knowledgeEntriesTable.reviewStatus, "draft")));
      await tx
        .update(knowledgeSourceDocumentsTable)
        .set({
          draftCount: new Set(draftLinks.map((link) => link.entryId)).size,
          updatedByEmail: req.staff!.email,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSourceDocumentsTable.id, documentId));
      return {
        addedDrafts: plan.toInsert.length,
        skippedExisting: plan.skippedExisting,
        approvedPreserved: plan.approvedPreserved,
        draftCount: new Set(draftLinks.map((link) => link.entryId)).size,
      };
    });
    res.json(result);
  } catch (error) {
    if (error instanceof KnowledgeDocumentError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    req.log.error({ err: error, documentId }, "tone recovery commit failed");
    res.status(422).json({ error: error instanceof Error ? error.message : "Tone recovery could not be saved" });
  } finally {
    toneRecoveryInFlight.delete(staffKey);
  }
});

// The retry endpoint intentionally has no options/body: every invocation is
// guarded server-side and replaces only draft entries linked solely to this
// document. This keeps callers safe by default and avoids an OpenAPI option
// that could accidentally request an approval/shared-entry overwrite.
router.post("/knowledge/documents/:id/retry", requireAdmin, async (req, res): Promise<void> => {
  const documentId = String(req.params.id);
  if (!z.string().uuid().safeParse(documentId).success) {
    res.status(400).json({ error: "A valid knowledge document id is required" });
    return;
  }
  try {
    const result = await retryKnowledgeDocument(documentId, req.staff!.email);
    res.json(result);
  } catch (error) {
    if (error instanceof KnowledgeDocumentError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    req.log.error({ err: error, documentId }, "knowledge document retry failed");
    res.status(422).json({ error: error instanceof Error ? error.message : "Knowledge document retry failed" });
  }
});

router.get("/knowledge/sources", async (_req, res) => {
  const rows = await db.select().from(knowledgeSourcesTable).orderBy(desc(knowledgeSourcesTable.updatedAt));
  res.json(rows.map(dto));
});
router.post("/knowledge/sources/google-drive", requireAdmin, async (req, res): Promise<void> => {
  const raw = String(req.body?.folderUrl ?? req.body?.folderId ?? "").trim();
  const match = raw.match(/(?:folders\/)?([a-zA-Z0-9_-]{10,})/);
  if (!match) { res.status(400).json({ error: "A valid Google Drive folder URL or folder ID is required" }); return; }
  const folderId = match[1]!;
  try {
    const folder = await driveProxy(`/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`);
    if (folder.mimeType !== "application/vnd.google-apps.folder") throw new Error("Selected Drive item is not a folder");
    const [source] = await db.insert(knowledgeSourcesTable).values({
      kind: "google_drive", name: req.body?.name || folder.name, sourceUrl: folder.webViewLink || driveUrl(folderId),
      driveFolderId: folderId, status: "active", createdByEmail: req.staff!.email, updatedByEmail: req.staff!.email,
    }).returning();
    res.status(201).json(dto(source!));
  } catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : "Drive folder validation failed" }); }
});
router.post("/knowledge/sources/:id/sync", async (req, res): Promise<void> => {
  const [source] = await db.select().from(knowledgeSourcesTable).where(eq(knowledgeSourcesTable.id, req.params.id));
  if (!source || source.kind !== "google_drive") { res.status(404).json({ error: "Google Drive source not found" }); return; }
  try {
    const result = await runDriveSourceSync(source.id, req.staff!.email);
    res.json({ sourceId: source.id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});
router.get("/knowledge/sources/:id/documents", async (req, res) => {
  const rows = await db.select().from(knowledgeSourceDocumentsTable).where(eq(knowledgeSourceDocumentsTable.sourceId, req.params.id)).orderBy(desc(knowledgeSourceDocumentsTable.updatedAt));
  const documentIds = rows.map((row) => row.id);
  const links = documentIds.length
    ? await db.select().from(knowledgeEntrySourcesTable).where(inArray(knowledgeEntrySourcesTable.documentId, documentIds))
    : [];
  res.json(rows.map((r) => ({
    ...r,
    objectPath: undefined,
    extractedText: undefined,
    staleEntryCount: links.filter((l) => l.documentId === r.id && l.stale === "true").length,
  })));
});
router.patch("/knowledge/sources/:id", requireAdmin, async (req, res) => {
  const status = req.body?.status;
  if (!["active", "paused"].includes(status)) { res.status(400).json({ error: "status must be active or paused" }); return; }
  const sourceId = String(req.params.id);
  const row = (await db.update(knowledgeSourcesTable).set({ status, updatedByEmail: req.staff!.email, updatedAt: new Date() }).where(eq(knowledgeSourcesTable.id, sourceId)).returning())[0];
  if (!row) { res.status(404).json({ error: "Source not found" }); return; }
  res.json(dto(row));
});
router.delete("/knowledge/sources/:id", requireAdmin, async (req, res) => {
  const sourceId = String(req.params.id);
  const row = (await db.update(knowledgeSourcesTable)
    .set({ status: "deleted", updatedByEmail: req.staff!.email, updatedAt: new Date() })
    .where(eq(knowledgeSourcesTable.id, sourceId))
    .returning())[0];
  if (!row) { res.status(404).json({ error: "Source not found" }); return; }
  const documents = await db.select({ id: knowledgeSourceDocumentsTable.id })
    .from(knowledgeSourceDocumentsTable)
    .where(eq(knowledgeSourceDocumentsTable.sourceId, row.id));
  if (documents.length) {
    const ids = documents.map((document) => document.id);
    await db.update(knowledgeSourceDocumentsTable)
      .set({ status: "deleted", updatedByEmail: req.staff!.email, updatedAt: new Date() })
      .where(inArray(knowledgeSourceDocumentsTable.id, ids));
    await db.update(knowledgeEntrySourcesTable)
      .set({ stale: "true" })
      .where(inArray(knowledgeEntrySourcesTable.documentId, ids));
  }
  res.sendStatus(204);
});
export default router;