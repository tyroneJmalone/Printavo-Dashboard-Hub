import { ReplitConnectors } from "@replit/connectors-sdk";
import { appSettingsTable, db, vendorOrdersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { toVendorOrderDto, type VendorTrackingEntry } from "./vendorSubmit";
import type { RefreshResult } from "./vendorTracking";
import { carrierCode, isStaleCarrierUpdate, mayRequestCarrier, normalizeCarrierTracking, withCarrierDeadline } from "./trackingLogic";

const SETTING_KEY = "shippo_external_tracking_enabled";
const CACHE_MS = 6 * 60 * 60 * 1000;
const inFlight = new Set<string>();

export async function getCarrierTrackingSettings(): Promise<{ enabled: boolean }> {
  const [setting] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, SETTING_KEY));
  return { enabled: (setting?.value as { enabled?: unknown } | undefined)?.enabled === true };
}

export async function setCarrierTrackingSettings(enabled: boolean): Promise<{ enabled: boolean }> {
  await db.insert(appSettingsTable).values({ key: SETTING_KEY, value: { enabled } })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: { enabled }, updatedAt: new Date() } });
  return { enabled };
}

async function getTracking(carrier: string, number: string): Promise<unknown> {
  // SDK proxy() does not expose signal; createProxyFetch does, including on its
  // auth retry. The deadline covers both response headers and JSON body.
  const proxyFetch = new ReplitConnectors().createProxyFetch("shippo");
  return withCarrierDeadline(async (signal) => {
    const response = await proxyFetch(
      `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(number)}`,
      { method: "GET", signal },
    );
    if (!response.ok) throw new Error(`Shippo tracking returned HTTP ${response.status}`);
    return response.json();
  });
}

/** Merge against the latest DB value, retrying on simultaneous vendor/carrier writes. */
async function persistTracking(id: string, incoming: VendorTrackingEntry): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [current] = await db.select().from(vendorOrdersTable).where(eq(vendorOrdersTable.id, id));
    if (!current || current.mode !== "live" || current.archived) return;
    const tracking = (current.tracking as VendorTrackingEntry[] | null) ?? [];
    const index = tracking.findIndex((t) => t.trackingNumber === incoming.trackingNumber);
    if (index < 0) return;
    // Another worker may have completed a newer carrier lookup while this
    // one was in flight. Neither stale success nor stale error may replace it.
    if (isStaleCarrierUpdate(tracking[index], incoming)) return;
    const merged = tracking.map((t, i) => i === index ? {
      ...t,
      ...(incoming.carrierError ? {} : {
        carrierStatus: incoming.carrierStatus,
        carrierStatusDate: incoming.carrierStatusDate,
        carrierStatusDetails: incoming.carrierStatusDetails,
        carrierLocation: incoming.carrierLocation,
        carrierHistory: incoming.carrierHistory,
        origin: incoming.origin,
        eta: incoming.eta,
        deliveredAt: incoming.deliveredAt,
      }),
      carrierCheckedAt: incoming.carrierCheckedAt,
      carrierError: incoming.carrierError,
    } : t);
    const [saved] = await db.update(vendorOrdersTable).set({ tracking: merged, updatedAt: new Date() })
      .where(and(eq(vendorOrdersTable.id, id), sql`${vendorOrdersTable.tracking} IS NOT DISTINCT FROM ${JSON.stringify(tracking)}::jsonb`))
      .returning({ id: vendorOrdersTable.id });
    if (saved) return;
  }
  throw new Error("Tracking changed during carrier refresh; retry later.");
}

export async function refreshCarrierTracking(id: string): Promise<RefreshResult> {
  const [row] = await db.select().from(vendorOrdersTable).where(eq(vendorOrdersTable.id, id));
  if (!row) return { outcome: "not_found", vendorOrder: null, message: "Order not found." };
  if (row.mode !== "live" || row.status !== "submitted" || row.archived)
    return { outcome: "not_refreshable", vendorOrder: toVendorOrderDto(row), message: "Only active submitted live orders can use carrier tracking." };
  if (!(await getCarrierTrackingSettings()).enabled)
    return { outcome: "not_refreshable", vendorOrder: toVendorOrderDto(row), message: "Paid Shippo carrier tracking is disabled. An admin must opt in first." };
  if (inFlight.has(id))
    return { outcome: "not_refreshable", vendorOrder: toVendorOrderDto(row), message: "Carrier check already running." };
  inFlight.add(id);
  try {
    let errors = 0;
    let checked = 0;
    for (const entry of (row.tracking as VendorTrackingEntry[] | null) ?? []) {
      if (!mayRequestCarrier((await getCarrierTrackingSettings()).enabled, entry, Date.now())) continue;
      const carrier = carrierCode(entry.carrier, entry.trackingNumber);
      if (!carrier) continue;
      // Recheck the persisted opt-in before every chargeable request.
      if (!(await getCarrierTrackingSettings()).enabled) break;
      const checkedAt = new Date().toISOString();
      try {
        const result = await getTracking(carrier, entry.trackingNumber);
        await persistTracking(id, normalizeCarrierTracking(entry, result, checkedAt));
        checked++;
      } catch (err) {
        errors++;
        await persistTracking(id, { ...entry, carrierCheckedAt: checkedAt, carrierError: err instanceof Error ? err.message : "Carrier lookup failed" });
      }
    }
    const [updated] = await db.select().from(vendorOrdersTable).where(eq(vendorOrdersTable.id, id));
    return { outcome: errors ? "error" : "refreshed", vendorOrder: updated ? toVendorOrderDto(updated) : null,
      message: errors ? `${errors} carrier lookup(s) failed; previous shipment data retained.` :
        checked ? `${checked} carrier shipment(s) checked.` : "No eligible shipments need checking (cached, delivered, or carrier unknown)." };
  } finally {
    inFlight.delete(id);
  }
}

/** Small bounded production tick; never request carrier tracking while opt-in is off. */
export async function refreshDueShipments(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const rows = await db.select().from(vendorOrdersTable)
    .where(and(eq(vendorOrdersTable.mode, "live"), eq(vendorOrdersTable.status, "submitted"), eq(vendorOrdersTable.archived, false),
      // Even after every known package is delivered, the vendor may report a
      // later split shipment. Discover for a bounded post-submission window;
      // terminal carrier packages remain ineligible for paid polling.
      sql`COALESCE(${vendorOrdersTable.submittedAt}, ${vendorOrdersTable.createdAt}) >= NOW() - INTERVAL '45 days'`))
    .orderBy(vendorOrdersTable.updatedAt).limit(10);
  for (const row of rows) {
    let tracking = (row.tracking as VendorTrackingEntry[] | null) ?? [];
    if (!row.lastStatusCheckAt || Date.now() - row.lastStatusCheckAt.getTime() > CACHE_MS) {
      const { refreshVendorOrderStatus } = await import("./vendorTracking");
      const result = await refreshVendorOrderStatus(row.id);
      tracking = result.vendorOrder?.tracking ?? tracking;
    }
    if ((await getCarrierTrackingSettings()).enabled && tracking.some((t) => mayRequestCarrier(true, t, Date.now()))) {
      await refreshCarrierTracking(row.id);
    }
  }
}