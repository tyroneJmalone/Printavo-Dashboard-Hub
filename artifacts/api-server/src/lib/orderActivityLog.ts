import { sql, type SQL } from "drizzle-orm";

export const activityCategories = ["all", "status", "line-items", "order", "payments", "files", "printing"] as const;
export const activitySources = ["change_events", "pv_payments", "pv_files", "pq_print_jobs"] as const;
export class ActivityInputError extends Error {}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ActivityInputError("Invalid pagination parameter");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ActivityInputError(`Pagination must be between ${min} and ${max}`);
  return number;
}

export function activityDate(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) {
    throw new ActivityInputError("Dates must be ISO dates or UTC timestamps");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new ActivityInputError("Invalid date");
  return date.toISOString();
}

export interface ActivityCursor {
  v: 1;
  scope: string;
  time: string;
  source: string;
  id: string;
}
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function decodeActivityCursor(value: unknown, scope: string): ActivityCursor | null {
  if (value === undefined) return null;
  try {
    if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (cursor.v !== 1 || cursor.scope !== scope || typeof cursor.time !== "string" ||
      new Date(cursor.time).toISOString() !== cursor.time || !activitySources.includes(cursor.source) ||
      typeof cursor.id !== "string" || cursor.id.length < 1 || cursor.id.length > 200) throw new Error();
    return cursor;
  } catch {
    throw new ActivityInputError("Invalid cursor or cursor does not match this order/filter/access scope");
  }
}

/** Exact recorded identity and customer evidence only; never join by visual number. */
export function conversionIdentitySql(customerId: string | null): SQL {
  return sql`c.entity_type = 'order' AND c.event_type = 'converted'
    AND c.old_value->>'quoteHistoryVersion' = '1'
    AND c.old_value->>'orderType' = 'quote' AND c.new_value->>'orderType' = 'invoice'
    AND c.new_value->>'printavoId' = c.entity_id
    AND c.old_value->>'printavoId' IS NOT NULL
    AND c.old_value->>'printavoId' <> c.entity_id
    AND c.old_value->>'customerId' = ${customerId}
    AND c.new_value->>'customerId' = ${customerId}`;
}

export function printingAllowed(role: string | undefined, enabled: Set<string>): boolean {
  return role === "admin" || enabled.has("production");
}

/** Never return raw JSON blobs, email fields, or upstream URLs. */
export function safeActivityValue(value: unknown): string | null {
  if (value == null) return null;
  const clean = (item: unknown, depth: number): unknown => {
    if (depth > 5) return "[details omitted]";
    if (typeof item === "string") return item.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email omitted]").slice(0, 2000);
    if (typeof item === "number" || typeof item === "boolean" || item == null) return item;
    if (Array.isArray(item)) return item.slice(0, 50).map(v => clean(v, depth + 1));
    if (typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([key]) =>
      !/email|url|token|metadata/i.test(key)).slice(0, 50).map(([key, val]) => [key, clean(val, depth + 1)]));
    return null;
  };
  const result = clean(value, 0);
  return (typeof result === "string" ? result : JSON.stringify(result)).slice(0, 6000);
}