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
