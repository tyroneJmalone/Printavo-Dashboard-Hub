import { createHash } from "node:crypto";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`,
  );
  return `{${parts.join(",")}}`;
}

export function contentHashOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * Printavo renders the same instant in varying timezones between fetches
 * (e.g. "2026-07-07T14:58:17-05:00" vs "2026-07-07T19:58:17Z"), which
 * breaks content hashing. Canonicalize every ISO8601 string to UTC.
 */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function normalizeTimestamps<T>(value: T): T {
  if (typeof value === "string") {
    if (ISO_DATE_RE.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toISOString() as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeTimestamps(v)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeTimestamps(v);
    }
    return out as T;
  }
  return value;
}

export function moneyStr(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2);
}

export function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}
