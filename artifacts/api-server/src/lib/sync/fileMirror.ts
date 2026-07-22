import type { Logger } from "pino";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { db, pvFilesTable, type PvFile } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import {
  objectStorageClient,
  getPrivateObjectDir,
  parseObjectPath,
} from "../objectStorage";
import { runFileRegistrar } from "./fileRegistry";

/**
 * Backup module (B3) — file mirror worker.
 *
 * Independent drip loop (own interval — downloads hit no-auth public/CDN
 * URLs and do NOT consume the Printavo GraphQL rate budget). Each tick:
 *   1. registrar: scan files_stale orders → register pv_files rows
 *   2. mirror: download up to FILES_PER_TICK pending files (small
 *      concurrency, polite to the CDN) and stream them into the private
 *      object dir.
 *
 * Failure model (proven lesson: stamp attempted_at BEFORE each try and
 * order attempted ASC NULLS FIRST so permanently-failing rows cycle to
 * the back instead of starving the queue):
 *   - permanent-looking (HTTP 401/403/404/410, HTML where a PDF should
 *     be, bad magic bytes) → terminal 'failed' after 3 attempts
 *   - transient (network, 5xx, timeout) → terminal 'failed' after 10
 * Terminal rows are only requeued manually (or by re-registration with
 * a changed URL / order change for PDFs).
 *
 * Restart mid-download is safe: non-resumable GCS uploads only
 * materialize on finalize; the row stays pending with attempted_at set.
 */

const MIRROR_INTERVAL_MS = 60 * 1000;
const REGISTRAR_ORDERS_PER_TICK = 500;
const FILES_PER_TICK = 100;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 120 * 1000;
const MAX_BYTES = 200 * 1024 * 1024;
const PERMANENT_HTTP = new Set([401, 403, 404, 410]);
const MAX_ATTEMPTS_PERMANENT = 3;
const MAX_ATTEMPTS_TRANSIENT = 10;

class PermanentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDownloadError";
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f#?%*:|"<>\\/]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^\.+/, "_");
  return cleaned.slice(0, 80) || "file";
}

function extFromMime(mime: string | null): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
  };
  return map[mime.split(";")[0].trim()] ?? "";
}

function objectFileName(row: PvFile): string {
  if (row.sourceKind === "public_pdf") return "order.pdf";
  if (row.fileName) return `${row.sourceId}-${sanitizeFileName(row.fileName)}`;
  return `${row.sourceId}${extFromMime(row.mimeType)}`;
}

/** Full object path (incl. bucket) for a registry row. */
function buildObjectPath(row: PvFile): string {
  return (
    `${getPrivateObjectDir()}/pv-files/` +
    `${row.orderVisualId}-${row.orderPrintavoId}/` +
    `${row.sourceKind}/${objectFileName(row)}`
  );
}

/**
 * Download one file and stream it to object storage. Returns byte count
 * and the response content type.
 */
async function downloadToStorage(
  row: PvFile,
  fullPath: string,
): Promise<{ bytes: number; contentType: string | null }> {
  const res = await fetch(row.sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} downloading source`);
    if (PERMANENT_HTTP.has(res.status)) {
      throw new PermanentDownloadError(err.message);
    }
    throw err;
  }
  const contentType = res.headers.get("content-type");
  if (
    row.sourceKind === "public_pdf" &&
    contentType &&
    contentType.includes("text/html")
  ) {
    throw new PermanentDownloadError(
      `Expected PDF, got ${contentType} (auth wall or removed)`,
    );
  }
  if (!res.body) {
    throw new Error("Empty response body");
  }

  let bytes = 0;
  let firstChunkChecked = false;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!firstChunkChecked) {
        firstChunkChecked = true;
        if (
          row.sourceKind === "public_pdf" &&
          !chunk.subarray(0, 5).toString("latin1").startsWith("%PDF")
        ) {
          cb(new PermanentDownloadError("Response is not a PDF (bad magic bytes)"));
          return;
        }
      }
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        cb(new PermanentDownloadError(`File exceeds ${MAX_BYTES} byte cap`));
        return;
      }
      cb(null, chunk);
    },
  });

  const { bucketName, objectName } = parseObjectPath(fullPath);
  const gcsFile = objectStorageClient.bucket(bucketName).file(objectName);
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    guard,
    gcsFile.createWriteStream({
      resumable: false,
      metadata: {
        contentType:
          contentType?.split(";")[0].trim() ||
          row.mimeType ||
          "application/octet-stream",
      },
    }),
  );
  return { bytes, contentType: contentType?.split(";")[0].trim() ?? null };
}

async function mirrorOne(row: PvFile, logger: Logger): Promise<boolean> {
  // Stamp BEFORE the attempt so failures cycle to the back of the queue.
  const attempts = row.attempts + 1;
  await db
    .update(pvFilesTable)
    .set({ attempts, attemptedAt: new Date() })
    .where(eq(pvFilesTable.id, row.id));

  try {
    const fullPath = buildObjectPath(row);
    const { bytes, contentType } = await downloadToStorage(row, fullPath);
    await db
      .update(pvFilesTable)
      .set({
        status: "mirrored",
        objectPath: fullPath,
        byteSize: bytes,
        mimeType: row.mimeType ?? contentType,
        mirroredAt: new Date(),
        lastError: null,
      })
      .where(eq(pvFilesTable.id, row.id));
    return true;
  } catch (err) {
    const permanent = err instanceof PermanentDownloadError;
    const message = err instanceof Error ? err.message : String(err);
    const maxAttempts = permanent
      ? MAX_ATTEMPTS_PERMANENT
      : MAX_ATTEMPTS_TRANSIENT;
    const terminal = attempts >= maxAttempts;
    await db
      .update(pvFilesTable)
      .set({
        status: terminal ? "failed" : "pending",
        lastError: message,
      })
      .where(eq(pvFilesTable.id, row.id));
    logger[terminal ? "error" : "warn"](
      {
        fileId: row.id,
        visualId: row.orderVisualId,
        kind: row.sourceKind,
        attempts,
        terminal,
        err: message,
      },
      "File mirror attempt failed",
    );
    return false;
  }
}

export interface MirrorAgg {
  attempted: number;
  mirrored: number;
  failed: number;
}

export async function runMirrorBatch(
  limit: number,
  logger: Logger,
): Promise<MirrorAgg> {
  const agg: MirrorAgg = { attempted: 0, mirrored: 0, failed: 0 };
  const rows = await db
    .select()
    .from(pvFilesTable)
    .where(eq(pvFilesTable.status, "pending"))
    // Never-attempted first (newest orders first within that tier), then
    // oldest-attempt-first — failing rows cycle back, no starvation.
    .orderBy(
      sql`${pvFilesTable.attemptedAt} ASC NULLS FIRST`,
      desc(pvFilesTable.orderVisualId),
    )
    .limit(limit);
  if (rows.length === 0) return agg;

  const queue = [...rows];
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        agg.attempted += 1;
        const ok = await mirrorOne(row, logger);
        if (ok) agg.mirrored += 1;
        else agg.failed += 1;
      }
    },
  );
  await Promise.all(workers);
  return agg;
}

let timer: NodeJS.Timeout | null = null;
let active = false;
let lastTickAt: Date | null = null;
let lastResult: string | null = null;

export interface FileMirrorInfo {
  running: boolean;
  intervalMs: number;
  lastTickAt: string | null;
  lastResult: string | null;
}

export function fileMirrorInfo(): FileMirrorInfo {
  return {
    running: timer !== null,
    intervalMs: MIRROR_INTERVAL_MS,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    lastResult,
  };
}

async function tick(logger: Logger): Promise<void> {
  if (active) return;
  active = true;
  try {
    const reg = await runFileRegistrar(REGISTRAR_ORDERS_PER_TICK, logger);
    const mirror = await runMirrorBatch(FILES_PER_TICK, logger);
    lastTickAt = new Date();
    lastResult = `registered ${reg.filesRegistered} (orders ${reg.orders}); mirrored ${mirror.mirrored}/${mirror.attempted}`;
    if (mirror.attempted > 0 || reg.orders > 0) {
      logger.info({ reg, mirror }, "File mirror tick complete");
    }
  } catch (err) {
    lastTickAt = new Date();
    lastResult = `crashed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err }, "File mirror tick crashed");
  } finally {
    active = false;
  }
}

export function startFileMirror(logger: Logger): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick(logger);
  }, MIRROR_INTERVAL_MS);
  timer.unref();
  // Kick an immediate first tick so restarts resume the drain promptly.
  setTimeout(() => {
    void tick(logger);
  }, 5_000).unref();
  logger.info(
    { intervalMs: MIRROR_INTERVAL_MS, filesPerTick: FILES_PER_TICK },
    "File mirror worker started",
  );
}
