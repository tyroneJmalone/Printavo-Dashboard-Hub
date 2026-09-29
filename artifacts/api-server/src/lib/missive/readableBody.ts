import { htmlToText } from "../emailActivity/gmail";
import { missiveGet, type MissiveAccount } from "./client";

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 200;
const MAX_CACHE_BODY_LENGTH = 100_000;
const cache = new Map<string, { bodyText: string; expiresAt: number }>();
const pending = new Map<string, Promise<string>>();

/**
 * Call only after checking current thread authorization and message/mailbox
 * binding. Cache holds converted text, never raw HTML; failures are not cached.
 */
export async function missiveReadableBody(
  account: MissiveAccount,
  providerMessageId: string,
): Promise<string> {
  const key = JSON.stringify([account.label, providerMessageId]);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.bodyText;
  if (cached) cache.delete(key);
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= MAX_ENTRIES) throw new Error("Too many readable-body requests in progress");

  const request = (async () => {
    const payload = await missiveGet<{ messages?: unknown }>(
      `/v1/messages/${encodeURIComponent(providerMessageId)}`,
      account.token,
    );
    const message = Array.isArray(payload.messages) ? payload.messages[0] : payload.messages;
    if (!message || typeof message !== "object" || typeof (message as { body?: unknown }).body !== "string") {
      throw new Error("Missive message body is unavailable");
    }
    const bodyText = htmlToText((message as { body: string }).body);
    for (const [entryKey, value] of cache) {
      if (value.expiresAt <= Date.now()) cache.delete(entryKey);
    }
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    // Never truncate a message for presentation; skip caching unusually large bodies.
    if (bodyText.length <= MAX_CACHE_BODY_LENGTH) {
      cache.set(key, { bodyText, expiresAt: Date.now() + TTL_MS });
    }
    return bodyText;
  })();
  pending.set(key, request);
  try {
    return await request;
  } finally {
    pending.delete(key);
  }
}