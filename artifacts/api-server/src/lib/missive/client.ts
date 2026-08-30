import { ReplitConnectors } from "@replit/connectors-sdk";

const MISSIVE_API_ORIGIN = "https://public.missiveapp.com";
const MISSIVE_REQUEST_TIMEOUT_MS = 30_000;
const MISSIVE_REQUEST_INTERVAL_MS = 1_100;
const MISSIVE_MAX_ATTEMPTS = 6;
let requestQueue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;

export class MissiveApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function missiveTransport(): "direct" | "connector" {
  return process.env.MISSIVE_API_TOKEN?.trim() ? "direct" : "connector";
}

export interface MissiveAccount {
  /** Human-readable label derived from the secret name — for logs/status only. */
  label: string;
  /** Bearer token. Undefined means "use the managed connector transport". */
  token: string | undefined;
}

/**
 * Every configured Missive account. Each team member's personal token is
 * stored as its own Replit Secret: MISSIVE_API_TOKEN is the primary account,
 * and MISSIVE_API_TOKEN_<NAME> (e.g. MISSIVE_API_TOKEN_ANDREW) adds a
 * teammate. Missive tokens only see conversations their own account can see,
 * so syncing every mailbox requires one token per person.
 */
export function missiveAccounts(): MissiveAccount[] {
  const accounts: MissiveAccount[] = [];
  const primary = process.env.MISSIVE_API_TOKEN?.trim();
  if (primary) accounts.push({ label: "primary", token: primary });
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MISSIVE_API_TOKEN_")) continue;
    const token = value?.trim();
    if (!token) continue;
    accounts.push({ label: key.slice("MISSIVE_API_TOKEN_".length).toLowerCase(), token });
  }
  if (accounts.length === 0) accounts.push({ label: "connector", token: undefined });
  return accounts;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
  const retryAt = header ? Date.parse(header) : Number.NaN;
  if (Number.isFinite(retryAt)) return Math.max(1_000, retryAt - Date.now());
  return Math.min(120_000, 5_000 * 2 ** attempt);
}

export function missiveApiUrl(path: string): URL {
  const rawPath = path.split("?", 1)[0] ?? "";
  if (!path.startsWith("/v1/") || /%2e/i.test(rawPath)) {
    throw new MissiveApiError(400, "Missive API paths must stay within /v1/");
  }
  const url = new URL(path, MISSIVE_API_ORIGIN);
  if (url.origin !== MISSIVE_API_ORIGIN || !url.pathname.startsWith("/v1/")) {
    throw new MissiveApiError(400, "Missive API paths must stay within /v1/");
  }
  return url;
}

async function scheduledRequest(work: () => Promise<Response>): Promise<Response> {
  let release!: () => void;
  const previous = requestQueue;
  requestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs) await sleep(waitMs);
    nextRequestAt = Date.now() + MISSIVE_REQUEST_INTERVAL_MS;
    return await work();
  } finally {
    release();
  }
}

/**
 * Prefer Missive's public API directly when a token is stored in Replit
 * Secrets. The managed connector remains available for environments without
 * that secret, but its server-side base URL cannot be overridden here.
 *
 * `accountToken` selects which configured Missive account performs the
 * request (see missiveAccounts). Omitted = the primary token / connector.
 */
export async function missiveGet<T>(path: string, accountToken?: string): Promise<T> {
  const url = missiveApiUrl(path);
  const token = accountToken?.trim() || process.env.MISSIVE_API_TOKEN?.trim();
  for (let attempt = 0; attempt < MISSIVE_MAX_ATTEMPTS; attempt++) {
    const response = await scheduledRequest(() =>
      token
        ? fetch(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(MISSIVE_REQUEST_TIMEOUT_MS),
          })
        : new ReplitConnectors().proxy("missive", path, {
            method: "GET",
            headers: { Accept: "application/json" },
          }),
    );
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
    if (response.status === 429 && attempt + 1 < MISSIVE_MAX_ATTEMPTS) {
      await sleep(retryDelay(response, attempt));
      continue;
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
        "Missive API returned a non-JSON response",
      );
    }
    return body as T;
  }
  throw new MissiveApiError(429, "Missive API rate limit retry budget exhausted");
}

export function missivePath(path: string, params?: Record<string, string | number | undefined>) {
  const url = new URL(`https://connector.invalid${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}