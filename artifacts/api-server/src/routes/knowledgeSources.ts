import { Router, type IRouter } from "express";
import multer from "multer";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { eq, and, desc, inArray } from "drizzle-orm";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { db, knowledgeEntriesTable, knowledgeSourcesTable, knowledgeSourceDocumentsTable, knowledgeEntrySourcesTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";
import { objectStorageClient, getPrivateObjectDir, parseObjectPath } from "../lib/objectStorage";
import { requireAdmin } from "../middlewares/requireStaff";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 15 * 1024 * 1024 } });
const ALLOWED: Record<string, string> = {
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
};
const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server")) ? path.resolve(process.cwd(), "../..") : process.cwd();
const AI_MODEL = "gpt-5.6-terra";
const DraftCandidateSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(2400),
  category: z.enum(["general", "policy", "pricing", "production", "shipping", "faq"]),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  expiresDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
type DraftCandidate = z.infer<typeof DraftCandidateSchema>;

async function enrichDrafts(
  chunks: Array<{ title: string; body: string }>,
  sourceName: string,
): Promise<DraftCandidate[]> {
  const enriched: DraftCandidate[] = [];
  for (let offset = 0; offset < chunks.length; offset += 12) {
    const batch = chunks.slice(offset, offset + 12);
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Extract reviewable company-knowledge draft candidates from source excerpts. Never invent a fact. Keep each body self-contained and faithful to its excerpt. Suggest one concise title, one allowed category (general, policy, pricing, production, shipping, faq), 0-8 lowercase tags, and effective/expiration dates only when explicitly stated as YYYY-MM-DD; otherwise use null. Return exactly one item for every input index as JSON: {\"drafts\":[{\"index\":0,\"title\":\"...\",\"body\":\"...\",\"category\":\"general\",\"tags\":[],\"effectiveDate\":null,\"expiresDate\":null}]}. These remain human-reviewed drafts, so preserve qualifications and exceptions.",
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceName,
            excerpts: batch.map((chunk, index) => ({
              index: offset + index,
              heading: chunk.title,
              text: chunk.body,
            })),
          }),
        },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 8192,
    });
    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { drafts?: unknown };
    const parsed = z.array(DraftCandidateSchema).safeParse(raw.drafts);
    if (!parsed.success) throw new Error(`AI draft extraction returned invalid data: ${parsed.error.message}`);
    const expected = new Set(batch.map((_, index) => offset + index));
    const returned = new Set(parsed.data.map((draft) => draft.index));
    if (returned.size !== expected.size || [...expected].some((index) => !returned.has(index))) {
      throw new Error("AI draft extraction did not return exactly one candidate per source excerpt");
    }
    enriched.push(...parsed.data);
  }
  return enriched.sort((a, b) => a.index - b.index);
}

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
    if (result.error || !result.text || !result.chunks?.length) throw new Error(result.error || "document contains no extractable text");
    return { text: result.text, chunks: result.chunks };
  } finally { await fs.unlink(tmp).catch(() => undefined); }
}

function dto(row: typeof knowledgeSourcesTable.$inferSelect) {
  return { id: row.id, kind: row.kind, name: row.name, sourceUrl: row.sourceUrl, driveFolderId: row.driveFolderId, status: row.status, lastSyncAt: row.lastSyncAt, lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

async function createDrafts(documentId: string, source: typeof knowledgeSourcesTable.$inferSelect, chunks: Array<{ title: string; body: string }>, email: string) {
  const candidates = await enrichDrafts(chunks, source.name);
  const existing = await db.select({ entryId: knowledgeEntrySourcesTable.entryId, sectionKey: knowledgeEntrySourcesTable.sectionKey })
    .from(knowledgeEntrySourcesTable).where(eq(knowledgeEntrySourcesTable.documentId, documentId));
  const seen = new Set(existing.map((x) => x.sectionKey));
  let count = 0;
  for (const chunk of candidates) {
    const key = createHash("sha256").update(chunk.title + "\n" + chunk.body).digest("hex");
    if (seen.has(key)) continue;
    const [entry] = await db.insert(knowledgeEntriesTable).values({
      title: chunk.title || source.name,
      body: chunk.body,
      category: chunk.category,
      tags: Array.from(new Set(chunk.tags.map((tag) => tag.toLowerCase()))),
      sourceName: source.name, sourceUrl: source.sourceUrl, reviewStatus: "draft",
      effectiveDate: chunk.effectiveDate,
      expiresDate: chunk.expiresDate,
      createdByEmail: email, updatedByEmail: email,
    }).returning();
    await db.insert(knowledgeEntrySourcesTable).values({ entryId: entry!.id, documentId, sectionKey: key });
    count++;
  }
  return count;
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
    drafts += documentDrafts;
    await db.update(knowledgeSourceDocumentsTable).set({ draftCount: (old?.draftCount ?? 0) + documentDrafts, updatedAt: new Date() }).where(eq(knowledgeSourceDocumentsTable.id, doc.id));
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
  await objectStorageClient.bucket(parsed.bucketName).file(parsed.objectName).save(file.buffer, { resumable: false, contentType: file.mimetype });
  try {
    const extracted = await extract(file);
    const doc = (await db.insert(knowledgeSourceDocumentsTable).values({
      sourceId: source.id, name: file.originalname, mimeType: file.mimetype, checksum, extractedText: extracted.text,
      objectPath, status: "active", createdByEmail: req.staff!.email, updatedByEmail: req.staff!.email,
    }).returning())[0]!;
    const draftCount = await createDrafts(doc.id, source, extracted.chunks, req.staff!.email);
    await db.update(knowledgeSourceDocumentsTable).set({ draftCount, updatedAt: new Date() }).where(eq(knowledgeSourceDocumentsTable.id, doc.id));
    res.status(201).json({ source: dto(source), documentId: doc.id, draftCount });
  } catch (error) {
    await db.insert(knowledgeSourceDocumentsTable).values({ sourceId: source.id, name: file.originalname, mimeType: file.mimetype, checksum, objectPath, status: "error", lastError: error instanceof Error ? error.message : String(error), createdByEmail: req.staff!.email, updatedByEmail: req.staff!.email });
    res.status(422).json({ error: error instanceof Error ? error.message : "Extraction failed" });
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