import { ReplitConnectors } from "@replit/connectors-sdk";

export class MissiveApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Create the connector SDK for every request. Connector identities can rotate;
 * caching this object risks holding stale credentials.
 */
export async function missiveGet<T>(path: string): Promise<T> {
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy("missive", path, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let body: unknown = null;
  if (contentType.includes("json") && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : contentType.includes("text/html")
          ? "connector returned HTML instead of the Missive API"
          : text.slice(0, 300);
    throw new MissiveApiError(response.status, `Missive API ${response.status}: ${detail}`);
  }
  if (!contentType.includes("json")) {
    throw new MissiveApiError(
      response.status,
      "Missive connector returned a non-JSON response",
    );
  }
  return body as T;
}

export function missivePath(path: string, params?: Record<string, string | number | undefined>) {
  const url = new URL(`https://connector.invalid${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}