import { Storage } from "@google-cloud/storage";

/**
 * GCS client authenticated via the Replit sidecar (App Storage).
 * Do not modify the credential block — sidecar auth is auto-configured.
 */
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectStorageSigningError extends Error {
  constructor(
    readonly kind: "http" | "invalid_response" | "unreachable",
    readonly status?: number,
  ) {
    super(`OBJECT_STORAGE_SIGNING_${kind.toUpperCase()}`);
    this.name = "ObjectStorageSigningError";
  }
}

export async function signObjectUploadURL(
  path: string,
  ttlSec = 900,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { bucketName, objectName } = parseObjectPath(path);
  let response: Response;
  try {
    response = await fetchImpl(
      `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket_name: bucketName,
          object_name: objectName,
          method: "PUT",
          expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new ObjectStorageSigningError("unreachable");
  }
  if (!response.ok) {
    throw new ObjectStorageSigningError("http", response.status);
  }
  try {
    const body = await response.json() as { signed_url?: unknown };
    if (typeof body.signed_url !== "string" || !body.signed_url.startsWith("https://")) {
      throw new ObjectStorageSigningError("invalid_response");
    }
    return body.signed_url;
  } catch (error) {
    if (error instanceof ObjectStorageSigningError) throw error;
    throw new ObjectStorageSigningError("invalid_response");
  }
}

/** Returns e.g. "/replit-objstore-<id>/.private" (no trailing slash). */
export function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set — provision App Storage (Object Storage tool).",
    );
  }
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

/** Split a "/<bucket>/<object...>" path into bucket + object name. */
export function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) {
    throw new Error("Invalid object path: must contain bucket and object name");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}
