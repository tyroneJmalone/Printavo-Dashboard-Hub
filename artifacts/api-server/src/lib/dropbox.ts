import { ReplitConnectors } from "@replit/connectors-sdk";

export const DROPBOX_READ_ENDPOINTS = new Set([
  "/2/files/list_folder",
  "/2/files/list_folder/continue",
  "/2/files/search_v2",
  "/2/files/get_metadata",
  "/2/files/get_temporary_link",
] as const);

export class DropboxError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DropboxMetadata {
  ".tag": "file" | "folder" | string;
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
}

async function readOperation<T>(
  endpoint: "/2/files/list_folder" | "/2/files/list_folder/continue" | "/2/files/search_v2" | "/2/files/get_metadata" | "/2/files/get_temporary_link",
  body: unknown,
): Promise<T> {
  if (!DROPBOX_READ_ENDPOINTS.has(endpoint)) {
    throw new DropboxError(500, "Unsupported Dropbox operation");
  }
  // Deliberately created per operation: connector clients must never be cached.
  const response = await new ReplitConnectors().proxy("dropbox", endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const summary =
      payload && typeof payload === "object" && "error_summary" in payload
        ? String((payload as { error_summary: unknown }).error_summary)
        : `Dropbox returned ${response.status}`;
    throw new DropboxError(response.status, summary);
  }
  return payload as T;
}

export function normalizeDropboxPath(value: string): string | null {
  const path = value.trim();
  if (path === "") return "";
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  return path.replace(/\/+$/, "").toLowerCase();
}

/** Segment-aware containment; /client cannot authorize /client-old. */
export function isDropboxPathWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeDropboxPath(path);
  const normalizedRoot = normalizeDropboxPath(root);
  if (normalizedPath === null || normalizedRoot === null) return false;
  return normalizedRoot === "" || normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

/** Canonical metadata is required before an id: locator can be trusted. */
export function isDropboxMetadataWithinRoot(
  metadata: Pick<DropboxMetadata, "path_lower">,
  rootPath: string,
): boolean {
  return Boolean(
    metadata.path_lower &&
      isDropboxPathWithinRoot(metadata.path_lower, rootPath),
  );
}

export async function getDropboxMetadata(pathOrId: string): Promise<DropboxMetadata> {
  return readOperation("/2/files/get_metadata", {
    path: pathOrId,
    include_deleted: false,
  });
}

export async function listDropboxFolder(input: {
  path?: string;
  cursor?: string;
  limit: number;
}): Promise<{
  entries: DropboxMetadata[];
  has_more: boolean;
  cursor?: string;
}> {
  if (input.cursor) {
    return readOperation("/2/files/list_folder/continue", { cursor: input.cursor });
  }
  return readOperation("/2/files/list_folder", {
    path: input.path ?? "",
    recursive: false,
    include_deleted: false,
    limit: Math.min(Math.max(input.limit, 1), 100),
  });
}

export async function searchDropbox(
  rootPath: string,
  query: string,
  limit: number,
): Promise<{ matches: Array<{ metadata?: { metadata?: DropboxMetadata } }>; has_more: boolean }> {
  return readOperation("/2/files/search_v2", {
    query,
    options: {
      path: rootPath,
      max_results: Math.min(Math.max(limit, 1), 50),
      file_status: "active",
    },
  });
}

export async function getDropboxTemporaryLink(pathOrId: string): Promise<string> {
  const result = await readOperation<{ link: string }>(
    "/2/files/get_temporary_link",
    { path: pathOrId },
  );
  return result.link;
}