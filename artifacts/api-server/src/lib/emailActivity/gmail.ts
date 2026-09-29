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

export function findBody(part: GmailMessagePart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return decodeBody(part.body.data);
  for (const child of part.parts ?? []) {
    const body = findBody(child, mimeType);
    if (body) return body;
  }
  return null;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥",
  bull: "•", hellip: "…", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);?/gi, (entity, value: string) => {
    if (value[0] !== "#") return HTML_ENTITIES[value.toLowerCase()] ?? entity;
    const hex = value[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : "\uFFFD";
  });
}

/** Read a tag's end without treating a quoted > in an attribute as the end. */
function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return -1;
}

/** Convert untrusted HTML email to text only; never parse into a browser DOM or load assets. */
export function htmlToText(html: string): string {
  let text = "";
  let position = 0;
  let hidden: string | null = null;
  let quoteDepth = 0;
  let preformatted = false;

  const newline = (count = 1) => {
    text = text.replace(/[ \t]+$/g, "");
    const existing = text.match(/\n*$/)?.[0].length ?? 0;
    text += "\n".repeat(Math.max(0, count - existing));
  };
  const append = (raw: string) => {
    if (!raw) return;
    const content = decodeEntities(preformatted ? raw : raw.replace(/\s+/g, " "));
    if (!content.trim()) {
      if (text && !/[ \n]$/.test(text)) text += " ";
      return;
    }
    if (quoteDepth && (text === "" || text.endsWith("\n"))) text += "> ".repeat(quoteDepth);
    text += content;
  };

  while (position < html.length) {
    const open = html.indexOf("<", position);
    if (open < 0) {
      if (!hidden) append(html.slice(position));
      break;
    }
    if (!hidden) append(html.slice(position, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) break;
      position = end + 3;
      continue;
    }
    const end = tagEnd(html, open);
    if (end < 0) {
      if (!hidden) append(html.slice(open));
      break;
    }
    const match = /^<\s*(\/?)\s*([a-z][\w:-]*)\b/i.exec(html.slice(open, end));
    position = end;
    if (!match) continue;
    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    if (hidden) {
      if (closing && tag === hidden) hidden = null;
      continue;
    }
    if (!closing && (tag === "script" || tag === "style" || tag === "head" || tag === "svg")) {
      hidden = tag;
      continue;
    }
    if (tag === "br") text += "\n";
    else if (tag === "hr") newline(2);
    else if (tag === "p") newline(2);
    else if (tag === "blockquote") {
      newline();
      quoteDepth = Math.max(0, quoteDepth + (closing ? -1 : 1));
      if (closing) newline();
    } else if (tag === "li") {
      newline();
      if (!closing) text += `${quoteDepth ? "> ".repeat(quoteDepth) : ""}• `;
    } else if (tag === "td" || tag === "th") {
      if (closing) text = text.replace(/[ \t]+$/g, "") + "\t";
    } else if (tag === "pre") {
      newline();
      preformatted = !closing;
    } else if (/^(div|section|article|header|footer|tr|table|ul|ol|h[1-6])$/.test(tag)) {
      newline();
    }
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Use the HTML alternative only to recover structure from a flattened plain part. */
export function readableMessageBody(payload: GmailMessagePart | undefined): string {
  const plain = findBody(payload, "text/plain");
  const html = findBody(payload, "text/html");
  const formatted = html ? htmlToText(html) : "";
  const body = !plain?.trim() || (!plain.includes("\n") && formatted.includes("\n"))
    ? formatted || plain || ""
    : plain;
  return body.trim().slice(0, 12_000);
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
    return readableMessageBody(message.payload);
  }
}
