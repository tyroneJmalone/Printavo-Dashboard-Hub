/**
 * Shared in-memory sliding-window rate limiter for AI surfaces.
 * Single-process server, so in-memory is intentional (documented in
 * docs/ai-context-layer.md). Keys are caller identities (consumer id,
 * staff id, ...).
 */
const WINDOW_MS = 60_000;
const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, limitPerMinute: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limitPerMinute) {
    const oldest = hits[0]!;
    buckets.set(key, hits);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }
  hits.push(now);
  buckets.set(key, hits);
  // Opportunistic cleanup so long-idle keys don't accumulate forever.
  if (buckets.size > 500) {
    for (const [k, v] of buckets) {
      if (v.every((t) => t <= cutoff)) buckets.delete(k);
    }
  }
  return { allowed: true, remaining: limitPerMinute - hits.length, retryAfterSeconds: 0 };
}
