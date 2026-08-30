/**
 * Short-TTL in-memory cache for hot context lookups (customer summary,
 * recent orders). Decision documented in docs/ai-context-layer.md: the
 * synced Printavo snapshot only changes on sync cycles, so a 30–60s cache
 * cannot serve meaningfully staler data than the snapshot itself, and it
 * keeps burst tool-calling (an AI often calls the same lookup 2-3× per
 * conversation) off the database. Single process, so in-memory is fine.
 */
const MAX_ENTRIES = 500;
const store = new Map<string, { value: unknown; expiresAt: number }>();

export function cacheGet(key: string): { hit: boolean; value?: unknown } {
  const entry = store.get(key);
  if (!entry) return { hit: false };
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

export function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  if (store.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt < now) store.delete(k);
    }
    // Still full of live entries → drop oldest-inserted to make room.
    if (store.size >= MAX_ENTRIES) {
      const first = store.keys().next();
      if (!first.done) store.delete(first.value);
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}
