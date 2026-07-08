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

/**
 * Printavo renders `transactionDate` as a date-only string in whatever
 * timezone the responding server happens to use (observed: UTC, -04:00,
 * -05:00 — varying PER NODE within one response, likely cached fragments).
 * The account timezone is America/New_York, so the same payment can
 * flip-flop ±1 day across fetches.
 *
 * Two anchor classes were confirmed empirically (July 2026):
 *  - PROCESSOR payments (credit card): anchored at the payment's creation
 *    INSTANT. An evening-ET payment renders as the next day under UTC.
 *  - MANUAL payments (check/cash) and user-edited dates: anchored at
 *    MIDNIGHT Eastern. A server west of Eastern renders the previous day.
 *
 * Per-node detection: the raw `timestamps.createdAt` string reveals the
 * render timezone. If the rendered transactionDate equals the creation
 * instant cast in that render timezone, the anchor is the instant itself —
 * canonical value is the creation instant's Eastern date. Otherwise the
 * anchor is midnight-Eastern — add one day when rendered west of Eastern.
 *
 * MUST be called with the RAW createdAt string, before normalizeTimestamps()
 * erases the render offset.
 */
export function canonicalTransactionDate(
  rawCreatedAt: string | null | undefined,
  renderedDate: string | null | undefined,
): string | null {
  if (!renderedDate) return null;
  if (!rawCreatedAt || !ISO_DATE_RE.test(rawCreatedAt)) return renderedDate;
  const instant = new Date(rawCreatedAt);
  if (Number.isNaN(instant.getTime())) return renderedDate;

  const renderOffsetMin = renderOffsetMinutes(rawCreatedAt);
  if (renderOffsetMin === null) return renderedDate;

  // Anchor = creation instant? (rendered date matches instant in render TZ)
  if (dateAtOffset(instant, renderOffsetMin) === renderedDate) {
    return easternDateOf(instant);
  }

  // Anchor = midnight Eastern: west-of-Eastern renders land one day early.
  return renderOffsetMin < easternOffsetMinutes(instant)
    ? shiftDateOnly(renderedDate, 1)
    : renderedDate;
}

function renderOffsetMinutes(rawIso: string): number | null {
  if (/Z$/.test(rawIso)) return 0;
  const m = rawIso.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function dateAtOffset(instant: Date, offsetMin: number): string {
  return new Date(instant.getTime() + offsetMin * 60_000)
    .toISOString()
    .slice(0, 10);
}

function easternDateOf(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function easternOffsetMinutes(instant: Date): number {
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = tzName?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return -300;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Shift a date-only string ("YYYY-MM-DD") by whole days. */
export function shiftDateOnly(dateStr: string, days: number): string {
  if (days === 0) return dateStr;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
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
