import type { VendorTrackingEntry } from "./vendorSubmit";
import { isNull, sql, type AnyColumn } from "drizzle-orm";

/** Compare the raw DB snapshot, not the normalized [] used for merging.
 * SQL NULL and JSONB [] are different states. */
export function trackingSnapshotCas(column: AnyColumn, snapshot: unknown) {
  return snapshot === null
    ? isNull(column)
    : sql`${column} IS NOT DISTINCT FROM ${JSON.stringify(snapshot)}::jsonb`;
}

export class ShippoAccountBlocked extends Error {}

/** Only surface allowlisted wording, never arbitrary Shippo response bodies. */
export async function assertShippoResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if ([401, 402, 403].includes(response.status)) {
    let detail = "";
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string")
        detail = body.detail;
    } catch { /* non-JSON auth failure */ }
    if (/valid payment method|payment method on file|billing/i.test(detail)) {
      throw new ShippoAccountBlocked("Shippo billing required: add a valid payment method at https://goshippo.com/user/billing/ before checking carriers.");
    }
    throw new ShippoAccountBlocked(`Shippo account authorization failed (HTTP ${response.status}); check the Shippo connection and billing.`);
  }
  throw new Error(`Shippo tracking returned HTTP ${response.status}`);
}

const string = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const place = (v: unknown): string | null => {
  const p = record(v);
  return [string(p.city), string(p.state), string(p.country)].filter(Boolean).join(", ") || null;
};
const date = (v: unknown): string | null => {
  const s = string(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};

export function carrierCode(carrier: string | null, number: string): string | null {
  const c = (carrier ?? "").toLowerCase();
  if (c.includes("fedex")) return "fedex";
  if (c.includes("usps")) return "usps";
  if (c.includes("ups") || /^1Z/i.test(number)) return "ups";
  return null;
}

export function normalizeCarrierTracking(entry: VendorTrackingEntry, raw: unknown, checkedAt: string): VendorTrackingEntry {
  const payload = record(raw);
  const status = record(payload.tracking_status);
  if (!string(status.status)) throw new Error("Shippo response did not contain a tracking status");
  const state = string(status.status)?.toUpperCase();
  const known = ["UNKNOWN", "PRE_TRANSIT", "TRANSIT", "DELIVERED", "RETURNED", "FAILURE"];
  const history = Array.isArray(payload.tracking_history) ? payload.tracking_history : [];
  const delivered = history.map(record).find((h) => string(h.status)?.toUpperCase() === "DELIVERED");
  const deliveredAt = state === "DELIVERED"
    ? date(status.status_date) ?? date(record(delivered).status_date) ?? entry.deliveredAt ?? null
    : entry.deliveredAt ?? null;
  return {
    ...entry,
    carrierStatus: state && known.includes(state) ? state : "UNKNOWN",
    carrierStatusDate: date(status.status_date),
    carrierStatusDetails: string(status.status_details),
    carrierLocation: place(status.location),
    origin: place(payload.address_from) ?? entry.origin ?? null,
    eta: date(payload.eta) ?? entry.eta ?? null,
    deliveredAt,
    carrierCheckedAt: checkedAt,
    carrierError: null,
    carrierHistory: history.slice(0, 20).map((event) => {
      const h = record(event);
      return { status: string(h.status) ?? "UNKNOWN", date: date(h.status_date),
        details: string(h.status_details), location: place(h.location) };
    }),
  };
}

export function shouldCheckCarrier(entry: VendorTrackingEntry, now: number): boolean {
  if (entry.carrierStatus === "DELIVERED" || entry.carrierStatus === "RETURNED") return false;
  const checked = entry.carrierCheckedAt ? Date.parse(entry.carrierCheckedAt) : 0;
  return !checked || Number.isNaN(checked) || now - checked >= (entry.carrierError ? 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000);
}

export function mayRequestCarrier(enabled: boolean, entry: VendorTrackingEntry, now: number): boolean {
  return enabled && !!carrierCode(entry.carrier, entry.trackingNumber) && shouldCheckCarrier(entry, now);
}

export function isStaleCarrierUpdate(current: VendorTrackingEntry, incoming: VendorTrackingEntry): boolean {
  const checked = (s?: string | null) => s ? Date.parse(s) || 0 : 0;
  if (checked(current.carrierCheckedAt) > checked(incoming.carrierCheckedAt)) return true;
  // Errors have no new carrier event; they only update the check timestamp/error.
  return !incoming.carrierError && checked(current.carrierStatusDate) > checked(incoming.carrierStatusDate);
}

export function mergeVendorTracking(existing: VendorTrackingEntry[], incoming: VendorTrackingEntry[]): VendorTrackingEntry[] {
  const merged = [...existing];
  for (const item of incoming) {
    const index = merged.findIndex((t) => t.trackingNumber === item.trackingNumber);
    if (index < 0) merged.push(item);
    else merged[index] = { ...merged[index], ...item };
  }
  return merged;
}

export function deliverySummary(entries: VendorTrackingEntry[]): string {
  const delivered = entries.filter((e) => e.carrierStatus === "DELIVERED").length;
  return `${delivered}/${entries.length} known shipments delivered`;
}

/** Bounds SDK identity/proxy latency AND response-body reading. Abort reaches
 * createProxyFetch's underlying fetch (unlike proxy(), whose options omit signal).
 * The race also releases callers if an upstream step ignores cancellation. */
export async function withCarrierDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Shippo tracking timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}