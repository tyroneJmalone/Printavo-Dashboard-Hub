import { JWT } from "google-auth-library";

/**
 * Thin Gmail REST client for metadata-only sync.
 *
 * Auth: a Google Cloud service account with domain-wide delegation,
 * impersonating each tracked mailbox (JWT `subject`). Credentials come
 * from the GOOGLE_SERVICE_ACCOUNT_JSON Replit secret — the full JSON key
 * file contents. Scope is gmail.readonly, but every fetch here uses
 * format=metadata: subjects and headers only, never bodies.
 */

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

let cachedKey: ServiceAccountKey | null | undefined;

export function serviceAccountKey(): ServiceAccountKey | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    cachedKey = null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) throw new Error("missing client_email/private_key");
    cachedKey = { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is set but not a valid service-account key JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return cachedKey;
}

export function gmailConfigured(): boolean {
  try {
    return serviceAccountKey() !== null;
  } catch {
    return false;
  }
}

/** client_email is safe to display — the admin needs it for the DWD setup. */
export function serviceAccountEmail(): string | null {
  try {
    return serviceAccountKey()?.client_email ?? null;
  } catch {
    return null;
  }
}

export class GmailApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate: string; // epoch ms as string
  sizeEstimate?: number;
  payload?: { headers?: { name: string; value: string }[] };
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessageFull {
  payload?: GmailMessagePart;
}

function decodeBody(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function findBody(part: GmailMessagePart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return decodeBody(part.body.data);
  for (const child of part.parts ?? []) {
    const body = findBody(child, mimeType);
    if (body) return body;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class GmailMailboxClient {
  private jwt: JWT;

  constructor(private userEmail: string) {
    const key = serviceAccountKey();
    if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not configured");
    this.jwt = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [SCOPE],
      subject: userEmail,
    });
  }

  private async get<T>(path: string, params?: Record<string, string | string[] | undefined>): Promise<T> {
    const token = await this.jwt.getAccessToken();
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, v);
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token.token}` } });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? "";
      } catch {
        /* non-JSON error body */
      }
      throw new GmailApiError(res.status, `Gmail API ${res.status} for ${this.userEmail}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  }

  getProfile(): Promise<GmailProfile> {
    return this.get<GmailProfile>("/profile");
  }

  listMessages(opts: { q?: string; pageToken?: string; maxResults?: number }): Promise<{
    messages?: { id: string; threadId: string }[];
    nextPageToken?: string;
  }> {
    return this.get("/messages", {
      q: opts.q,
      pageToken: opts.pageToken,
      maxResults: String(opts.maxResults ?? 500),
    });
  }

  listHistory(opts: { startHistoryId: string; pageToken?: string }): Promise<{
    history?: { messagesAdded?: { message: { id: string; threadId: string } }[] }[];
    nextPageToken?: string;
    historyId?: string;
  }> {
    return this.get("/history", {
      startHistoryId: opts.startHistoryId,
      historyTypes: "messageAdded",
      pageToken: opts.pageToken,
      maxResults: "500",
    });
  }

  /** Metadata only — subjects and routing headers, never bodies. */
  getMessageMetadata(id: string): Promise<GmailMessageMeta> {
    return this.get<GmailMessageMeta>(`/messages/${id}`, {
      format: "metadata",
      metadataHeaders: [
        "From",
        "To",
        "Cc",
        "Subject",
        "List-Unsubscribe",
        "Precedence",
        "Auto-Submitted",
      ],
    });
  }

  /** Live, on-demand body fetch for authorized previews. The caller must not persist it. */
  async getMessageBody(id: string): Promise<string> {
    const message = await this.get<GmailMessageFull>(`/messages/${id}`, { format: "full" });
    const plain = findBody(message.payload, "text/plain");
    const html = plain ? null : findBody(message.payload, "text/html");
    const body = (plain ?? (html ? htmlToText(html) : "")).trim();
    return body.slice(0, 12_000);
  }
}
