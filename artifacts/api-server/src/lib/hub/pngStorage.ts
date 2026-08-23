import { randomBytes, randomUUID } from "node:crypto";
import {
  objectStorageClient,
  getPrivateObjectDir,
  parseObjectPath,
} from "../objectStorage";
import { db, hubCalcUploadsTable, pvOrdersTable, type InsertHubCalcUpload } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { publicBaseUrl } from "../publicUrl";
import {
  validatePriceRows,
  computeDedupeKey,
  sanitizeFilename,
  VALID_RANGE_KEYS,
} from "./pureHelpers";

export { validatePriceRows, computeDedupeKey, sanitizeFilename, VALID_RANGE_KEYS };

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const PNG_UPLOAD_TTL_SEC = 900; // 15 minutes
export const MAX_PNG_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_PNG_BYTES = 8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Subpath within PRIVATE_OBJECT_DIR for Hub calculator PNGs. */
const HUB_CALC_STAGING_SUBDIR = "hub-calc/staging";
const HUB_CALC_FINALIZED_SUBDIR = "hub-calc/finalized";

export class HubUploadError extends Error {
  constructor(
    message: string,
    public readonly kind: "not_found" | "invalid" | "gcs_error",
  ) {
    super(message);
    this.name = "HubUploadError";
  }
}

/** 64-char hex token for the public URL (high entropy). */
function generatePublicToken(): string {
  return randomBytes(32).toString("hex");
}

async function signPutUrl(bucketName: string, objectName: string): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method: "PUT",
    expires_at: new Date(Date.now() + PNG_UPLOAD_TTL_SEC * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL: ${response.status} — ensure App Storage is provisioned`,
    );
  }
  const { signed_url: signedUrl } = (await response.json()) as { signed_url: string };
  return signedUrl;
}

export interface PngUploadSlot {
  uploadId: string;
  uploadUrl: string | null; // null when deduped row is already uploaded/pushed
  objectPath: string;
  publicUrl: string;
  dedupe: boolean;
}

/**
 * Validate invoiceId+visualId against the local pv_orders mirror.
 * Throws HubUploadError if not found or if visualId mismatches.
 */
async function validateInvoiceMirror(
  invoiceId: string,
  visualId: number,
): Promise<void> {
  const [row] = await db
    .select({ printavoId: pvOrdersTable.printavoId, visualId: pvOrdersTable.visualId })
    .from(pvOrdersTable)
    .where(
      and(
        eq(pvOrdersTable.printavoId, invoiceId),
        eq(pvOrdersTable.orderType, "invoice"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HubUploadError(
      `Invoice "${invoiceId}" not found in local mirror`,
      "not_found",
    );
  }
  if (row.visualId !== visualId) {
    throw new HubUploadError(
      `Invoice "${invoiceId}" has visualId ${row.visualId}, not ${visualId}`,
      "invalid",
    );
  }
}

/**
 * Reserve an upload slot: validates invoice, checks for existing dedupe row,
 * creates a hub_calc_uploads row, and returns a presigned PUT URL.
 *
 * For an identical snapshot (same invoiceId+visualId+quoteNumber+rangeKey+rows)
 * the existing row is returned and a fresh presigned URL is signed only if the
 * PNG has not yet been uploaded. If already uploaded/pushed, uploadUrl is null.
 */
export async function reservePngUploadSlot(opts: {
  invoiceId: string;
  visualId: number;
  rangeKey: string;
  priceRows: Array<{ qty: number; unitPrice: number }>;
  quoteNumber: string;
  note?: string | null;
}): Promise<PngUploadSlot> {
  const quoteNumber = opts.quoteNumber.trim();
  if (!/^\d{1,20}$/.test(quoteNumber)) {
    throw new HubUploadError(
      "Printavo quote number must contain 1–20 digits",
      "invalid",
    );
  }
  // Validate range key + rows
  const rowError = validatePriceRows(opts.priceRows, opts.rangeKey);
  if (rowError) throw new HubUploadError(rowError, "invalid");

  // Validate invoice against local mirror
  await validateInvoiceMirror(opts.invoiceId, opts.visualId);

  const dedupeKey = computeDedupeKey({
    invoiceId: opts.invoiceId,
    visualId: opts.visualId,
    quoteNumber,
    rangeKey: opts.rangeKey,
    priceRows: opts.priceRows,
  });

  // Check for existing dedupe row
  const [existing] = await db
    .select()
    .from(hubCalcUploadsTable)
    .where(eq(hubCalcUploadsTable.dedupeKey, dedupeKey))
    .limit(1);

  if (existing) {
    const alreadyUploaded = existing.status !== "pending";
    let uploadUrl: string | null = null;
    if (!alreadyUploaded) {
      const { bucketName, objectName } = parseObjectPath(existing.objectPath);
      uploadUrl = await signPutUrl(bucketName, objectName);
    }
    return {
      uploadId: existing.id,
      uploadUrl,
      objectPath: existing.objectPath,
      publicUrl: hubCalcPngPublicUrl(existing.publicToken, existing.publicFilename),
      dedupe: true,
    };
  }

  // Build new row
  const dir = getPrivateObjectDir();
  const objectId = randomUUID();
  const objectPath = `${dir}/${HUB_CALC_STAGING_SUBDIR}/${objectId}.png`;
  const { bucketName, objectName } = parseObjectPath(objectPath);

  const publicToken = generatePublicToken();
  const quoteLabel = sanitizeFilename(`Q${quoteNumber}`);
  const publicFilename = `hub-calc-${quoteLabel}-${objectId.slice(0, 8)}.png`;

  const row: InsertHubCalcUpload = {
    invoiceId: opts.invoiceId,
    visualId: opts.visualId,
    rangeKey: opts.rangeKey,
    quoteNumber,
    objectPath,
    publicToken,
    publicFilename,
    status: "pending",
    note: opts.note ?? null,
    dedupeKey,
    priceRows: opts.priceRows,
  };

  let created: typeof row & { id: string } | undefined;
  try {
    const [c] = await db.insert(hubCalcUploadsTable).values(row).returning();
    created = c;
  } catch (err: unknown) {
    // Race: another request inserted the same dedupeKey concurrently — load it
    const isUniqueViolation =
      err instanceof Error && err.message.includes("hub_calc_uploads_dedupe_key_uq");
    if (isUniqueViolation) {
      const [winner] = await db
        .select()
        .from(hubCalcUploadsTable)
        .where(eq(hubCalcUploadsTable.dedupeKey, dedupeKey))
        .limit(1);
      if (winner) {
        const alreadyUploaded = winner.status !== "pending";
        let uploadUrl: string | null = null;
        if (!alreadyUploaded) {
          const { bucketName: b, objectName: o } = parseObjectPath(winner.objectPath);
          uploadUrl = await signPutUrl(b, o);
        }
        return {
          uploadId: winner.id,
          uploadUrl,
          objectPath: winner.objectPath,
          publicUrl: hubCalcPngPublicUrl(winner.publicToken, winner.publicFilename),
          dedupe: true,
        };
      }
    }
    throw err;
  }

  if (!created) throw new Error("Failed to create upload row");

  const uploadUrl = await signPutUrl(bucketName, objectName);
  return {
    uploadId: created.id,
    uploadUrl,
    objectPath,
    publicUrl: hubCalcPngPublicUrl(publicToken, publicFilename),
    dedupe: false,
  };
}

/**
 * Construct the public unauthenticated URL for a Hub calc PNG.
 */
export function hubCalcPngPublicUrl(publicToken: string, publicFilename: string): string {
  const safeFilename = sanitizeFilename(publicFilename);
  return `${publicBaseUrl()}/api/hub/uploads/${publicToken}/${safeFilename}`;
}

export type GcsVerifyResult =
  | { ok: true; size: number; generation: string }
  | { ok: false; reason: string };

async function inspectPngObject(
  file: ReturnType<ReturnType<typeof objectStorageClient.bucket>["file"]>,
): Promise<GcsVerifyResult> {
  let exists: boolean;
  try {
    [exists] = await file.exists();
  } catch (err) {
    return {
      ok: false,
      reason: `GCS exists check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!exists) return { ok: false, reason: "Object not found in GCS" };

  let metadata: { size?: unknown; contentType?: unknown; generation?: unknown };
  try {
    [metadata] = await file.getMetadata();
  } catch (err) {
    return {
      ok: false,
      reason: `GCS metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const size = Number(metadata.size ?? 0);
  if (!Number.isFinite(size) || size < MIN_PNG_BYTES || size > MAX_PNG_BYTES) {
    return {
      ok: false,
      reason: `Object size ${size} is outside the allowed range ${MIN_PNG_BYTES}..${MAX_PNG_BYTES}`,
    };
  }

  const ct = String(metadata.contentType ?? "").toLowerCase();
  if (ct !== "image/png") {
    return { ok: false, reason: `Content-Type "${ct || "(missing)"}" is not image/png` };
  }

  let signature: Buffer;
  try {
    [signature] = await file.download({ start: 0, end: PNG_SIGNATURE.length - 1 });
  } catch (err) {
    return {
      ok: false,
      reason: `PNG signature read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (signature.length < PNG_SIGNATURE.length || !signature.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, reason: "Object bytes do not have a valid PNG signature" };
  }

  const generation = String(metadata.generation ?? "");
  if (!generation) {
    return { ok: false, reason: "Object generation is missing" };
  }
  return { ok: true, size, generation };
}

/**
 * Verify PNG metadata and magic bytes. The first successful verification copies
 * the client-writable staging object to a server-owned finalized path, records
 * its immutable GCS generation, and only then marks the row uploaded. Later
 * checks validate that exact generation immediately before Printavo writes.
 */
export async function verifyAndConfirmPngUploaded(
  uploadId: string,
): Promise<GcsVerifyResult> {
  const [row] = await db
    .select()
    .from(hubCalcUploadsTable)
    .where(eq(hubCalcUploadsTable.id, uploadId))
    .limit(1);
  if (!row) return { ok: false, reason: "Upload row not found" };

  const { bucketName, objectName } = parseObjectPath(row.objectPath);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  const inspected = await inspectPngObject(file);
  if (!inspected.ok) return inspected;

  if (row.status !== "pending") {
    if (!row.objectGeneration) {
      return { ok: false, reason: "Finalized PNG generation was not recorded" };
    }
    if (row.objectGeneration !== inspected.generation) {
      return {
        ok: false,
        reason: "Finalized PNG generation changed after verification",
      };
    }
    return inspected;
  }

  const finalizedPath = row.objectPath.replace(
    `/${HUB_CALC_STAGING_SUBDIR}/`,
    `/${HUB_CALC_FINALIZED_SUBDIR}/`,
  );
  if (finalizedPath === row.objectPath) {
    return { ok: false, reason: "Pending PNG does not use the staging path" };
  }
  const { objectName: finalizedObjectName } = parseObjectPath(finalizedPath);
  const finalizedFile = bucket.file(finalizedObjectName);

  try {
    await file.copy(finalizedFile, {
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? Number(err.code)
        : undefined;
    if (code !== 412) {
      return {
        ok: false,
        reason: `PNG finalization failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const finalized = await inspectPngObject(finalizedFile);
  if (!finalized.ok) return finalized;

  await db
    .update(hubCalcUploadsTable)
    .set({
      objectPath: finalizedPath,
      objectGeneration: finalized.generation,
      status: "uploaded",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(hubCalcUploadsTable.id, uploadId),
        eq(hubCalcUploadsTable.status, "pending"),
      ),
    );

  try {
    await file.delete({ ignoreNotFound: true });
  } catch {
    // The signed URL only targets staging; leaving it behind cannot change the
    // finalized object and cleanup can safely be deferred.
  }

  return finalized;
}

/**
 * Stream the PNG object for an upload row identified by its public token.
 * Returns null if the token is unknown or the object does not exist in GCS.
 */
export async function getHubCalcPngStream(
  publicToken: string,
): Promise<{ stream: NodeJS.ReadableStream; contentLength: string | undefined } | null> {
  const [row] = await db
    .select({
      objectPath: hubCalcUploadsTable.objectPath,
      status: hubCalcUploadsTable.status,
    })
    .from(hubCalcUploadsTable)
    .where(eq(hubCalcUploadsTable.publicToken, publicToken))
    .limit(1);

  if (!row) return null;
  if (row.status === "pending") return null;

  const { bucketName, objectName } = parseObjectPath(row.objectPath);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  const [exists] = await file.exists();
  if (!exists) return null;

  const [metadata] = await file.getMetadata();
  const stream = file.createReadStream();
  return {
    stream,
    contentLength: metadata.size ? String(metadata.size) : undefined,
  };
}
