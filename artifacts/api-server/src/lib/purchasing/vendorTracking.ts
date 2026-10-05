import { db, vendorOrdersTable, type VendorOrder } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { SanMarApiError } from "@workspace/sanmar";
import { SSApiError } from "@workspace/ss-activewear";
import { mergeVendorTracking, trackingSnapshotCas } from "./trackingLogic";
import { submitPoToVendor } from "./poFiles";
import {
  VendorNotConfigured,
  sanMarClient,
  ssClient,
  toVendorOrderDto,
  type VendorOrderDto,
  type VendorTrackingEntry,
} from "./vendorSubmit";

/**
 * Read-only vendor status/tracking lookups + reconciliation of "unknown" rows.
 *
 * Reconcile rules (asymmetric BY DESIGN — the anti-double-order guard depends
 * on these statuses):
 * - unknown → submitted happens AUTOMATICALLY when the vendor confirms the PO
 *   exists. Safe: the guard stays locked either way, we're just recording that
 *   the ambiguous send actually went through (and locking the PO file so the
 *   normal "already submitted" blocker kicks in too).
 * - unknown → failed is NEVER automatic. "Vendor has no record" right after a
 *   timeout can simply be ingest lag; flipping to failed re-enables live
 *   submission and a wrong flip means a DOUBLE ORDER. Only a human with the
 *   admin PIN can do it (markVendorOrderFailed), and the UI shows how long
 *   we've been checking so they can judge.
 * - Refreshes only touch LIVE rows in submitted/unknown. Test-mode orders
 *   never appear in the production status services, and refreshing a FAILED
 *   row would falsely "find" a later successful order under the same PO
 *   number (the failed 22377 attempt sits next to the successful one).
 */

export type RefreshOutcome =
  | "refreshed"
  | "reconciled"
  | "no_vendor_record"
  | "not_refreshable"
  | "not_found"
  | "not_configured"
  | "error";

export interface RefreshResult {
  outcome: RefreshOutcome;
  vendorOrder: VendorOrderDto | null;
  message: string | null;
}

export interface RefreshAllResult {
  checked: number;
  refreshed: number;
  reconciled: number;
  noRecord: number;
  errors: number;
  results: RefreshResult[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bounds one HTTP request; the underlying vendor lookup is read-only and
 * may finish later if its SDK cannot abort, but it must never persist then. */
export async function withVendorLookupDeadline<T>(lookup: Promise<T>, timeoutMs = 35_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Vendor lookup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface VendorLookup {
  /** Vendor has ANY record of this PO number. */
  found: boolean;
  vendorStatus: string | null;
  orderNumbers: string[];
  tracking: VendorTrackingEntry[];
}

function uniq(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

async function lookupSanMar(poNumber: string): Promise<VendorLookup> {
  const client = sanMarClient();
  const status = await client.getOrderStatus(poNumber);
  const shipment = await client.getShipmentNotification(poNumber);
  const statusNames = uniq(status.details.map((d) => d.statusName));
  const tracking: VendorTrackingEntry[] = [];
  const seen = new Set<string>();
  for (const p of shipment.packages) {
    if (!p.trackingNumber || seen.has(p.trackingNumber)) continue;
    seen.add(p.trackingNumber);
    tracking.push({
      orderNumber: p.orderNumber,
      carrier: p.carrier,
      trackingNumber: p.trackingNumber,
      shipMethod: p.shipMethod,
      shipmentDate: p.shipmentDate,
    });
  }
  return {
    found: status.found || shipment.found,
    vendorStatus: statusNames.length ? statusNames.join(", ") : null,
    // SanMar keys everything by the PO number itself; factoryOrderNumber is
    // informational. Keep the submit-time convention: [poNumber].
    orderNumbers: status.found || shipment.found ? [poNumber] : [],
    tracking,
  };
}

async function lookupSs(poNumber: string): Promise<VendorLookup> {
  const res = await ssClient().getOrders(poNumber);
  const statuses = uniq(res.orders.map((o) => o.orderStatus));
  const tracking: VendorTrackingEntry[] = [];
  const seen = new Set<string>();
  for (const o of res.orders) {
    if (!o.trackingNumber || seen.has(o.trackingNumber)) continue;
    seen.add(o.trackingNumber);
    tracking.push({
      orderNumber: o.orderNumber,
      carrier: o.shippingCarrier,
      trackingNumber: o.trackingNumber,
      shipMethod: o.shippingMethod,
      shipmentDate: o.shipDate,
    });
  }
  return {
    found: res.found,
    vendorStatus: statuses.length ? statuses.join(", ") : null,
    orderNumbers: uniq(res.orders.map((o) => o.orderNumber)),
    tracking,
  };
}

async function updateRow(id: string, patch: Partial<VendorOrder>): Promise<VendorOrder> {
  if (patch.tracking) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [latest] = await db.select().from(vendorOrdersTable).where(eq(vendorOrdersTable.id, id));
      if (!latest) throw new Error("Order disappeared during tracking refresh");
      const existing = (latest.tracking as VendorTrackingEntry[] | null) ?? [];
      const incoming = patch.tracking as VendorTrackingEntry[];
      const merged = mergeVendorTracking(existing, incoming);
      const [saved] = await db.update(vendorOrdersTable).set({ ...patch, tracking: merged, updatedAt: new Date() })
        .where(and(eq(vendorOrdersTable.id, id), trackingSnapshotCas(vendorOrdersTable.tracking, latest.tracking))).returning();
      if (saved) return saved;
    }
    throw new Error("Tracking changed during vendor refresh; retry later.");
  }
  const [row] = await db
    .update(vendorOrdersTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(vendorOrdersTable.id, id))
    .returning();
  return row;
}

/**
 * Update only if the row is still in the expected status — guards the two
 * status transitions (unknown→submitted, unknown→failed) against a concurrent
 * writer having already resolved the row. Returns undefined if the
 * precondition no longer holds.
 */
async function updateRowIfStatus(
  id: string,
  expectedStatus: VendorOrder["status"],
  patch: Partial<VendorOrder>,
): Promise<VendorOrder | undefined> {
  if (patch.tracking) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [latest] = await db.select().from(vendorOrdersTable).where(eq(vendorOrdersTable.id, id));
      if (!latest || latest.status !== expectedStatus) return undefined;
      const existing = (latest.tracking as VendorTrackingEntry[] | null) ?? [];
      const merged = mergeVendorTracking(existing, patch.tracking as VendorTrackingEntry[]);
      const [saved] = await db.update(vendorOrdersTable).set({ ...patch, tracking: merged, updatedAt: new Date() })
        .where(and(eq(vendorOrdersTable.id, id), eq(vendorOrdersTable.status, expectedStatus),
          trackingSnapshotCas(vendorOrdersTable.tracking, latest.tracking))).returning();
      if (saved) return saved;
    }
    throw new Error("Tracking changed during vendor reconciliation; retry later.");
  }
  const [row] = await db
    .update(vendorOrdersTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(vendorOrdersTable.id, id), eq(vendorOrdersTable.status, expectedStatus)))
    .returning();
  return row;
}

/** Lock the PO file as vendor-submitted, but never clobber an existing lock. */
async function lockPoIfUnlocked(poFileId: string, vendorOrderNumber: string): Promise<void> {
  await submitPoToVendor(poFileId, vendorOrderNumber);
}

function refreshable(row: VendorOrder): string | null {
  if (row.mode !== "live") {
    return `Only live orders can be checked with the vendor — this is a ${row.mode} record.`;
  }
  if (row.status !== "submitted" && row.status !== "unknown") {
    return `Only submitted or unknown orders can be checked — this one is ${row.status}.`;
  }
  if (row.archived) {
    return "This order is archived — unarchive it before checking the vendor.";
  }
  return null;
}

/**
 * One vendor status lookup for one vendor_orders row. Read-only against the
 * vendor; persists vendorStatus/tracking/lastStatusCheckAt and applies the
 * unknown→submitted auto-reconcile (see module docs).
 */
export async function refreshVendorOrderStatus(id: string): Promise<RefreshResult> {
  const [row] = await db
    .select()
    .from(vendorOrdersTable)
    .where(eq(vendorOrdersTable.id, id));
  if (!row) return { outcome: "not_found", vendorOrder: null, message: "Order not found." };

  const blocked = refreshable(row);
  if (blocked) {
    return { outcome: "not_refreshable", vendorOrder: toVendorOrderDto(row), message: blocked };
  }

  let lookup: VendorLookup;
  try {
    lookup = await withVendorLookupDeadline(
      row.vendor === "sanmar"
        ? lookupSanMar(row.poNumber)
        : lookupSs(row.poNumber),
    );
  } catch (err) {
    if (err instanceof VendorNotConfigured) {
      return { outcome: "not_configured", vendorOrder: toVendorOrderDto(row), message: err.message };
    }
    if (err instanceof SanMarApiError || err instanceof SSApiError) {
      return {
        outcome: "error",
        vendorOrder: toVendorOrderDto(row),
        message: `Vendor lookup failed: ${errMsg(err)}`,
      };
    }
    if (err instanceof Error && err.message.startsWith("Vendor lookup timed out after")) {
      return { outcome: "error", vendorOrder: toVendorOrderDto(row), message: err.message };
    }
    throw err;
  }

  const now = new Date();
  const patch: Partial<VendorOrder> = { lastStatusCheckAt: now };
  if (lookup.vendorStatus) patch.vendorStatus = lookup.vendorStatus;
  if (lookup.tracking.length) patch.tracking = lookup.tracking;

  if (row.status === "unknown") {
    if (lookup.found) {
      // Vendor confirms the ambiguous send actually went through — record it
      // as submitted (guard stays locked) and backfill what the submit path
      // would have written.
      patch.status = "submitted";
      patch.error = null;
      if (!row.submittedAt) patch.submittedAt = now;
      const existing = (row.vendorOrderNumbers as string[] | null) ?? [];
      const orderNumbers = existing.length
        ? existing
        : lookup.orderNumbers.length
          ? lookup.orderNumbers
          : [row.poNumber];
      patch.vendorOrderNumbers = orderNumbers;
      const updated = await updateRowIfStatus(row.id, "unknown", patch);
      if (!updated) {
        // Someone resolved the row (e.g. PIN mark-failed) while we were
        // talking to the vendor — leave their decision alone.
        const [current] = await db
          .select()
          .from(vendorOrdersTable)
          .where(eq(vendorOrdersTable.id, row.id));
        return {
          outcome: "not_refreshable",
          vendorOrder: current ? toVendorOrderDto(current) : null,
          message: "Order was resolved by someone else while checking the vendor — no changes made.",
        };
      }
      await lockPoIfUnlocked(row.poFileId, orderNumbers[0]);
      return {
        outcome: "reconciled",
        vendorOrder: toVendorOrderDto(updated),
        message: `Vendor confirmed PO ${row.poNumber} — order marked submitted.`,
      };
    }
    // NOT found: stays unknown. Never auto-fail — could be vendor lag, and a
    // wrong flip re-enables live submission (double-order risk).
    const updated = await updateRow(row.id, patch);
    return {
      outcome: "no_vendor_record",
      vendorOrder: toVendorOrderDto(updated),
      message: `Vendor has no record of PO ${row.poNumber} yet. This can be processing lag — if it persists, verify with the vendor directly before marking it failed.`,
    };
  }

  // status === "submitted": plain status/tracking refresh.
  const updated = await updateRow(row.id, patch);
  return {
    outcome: "refreshed",
    vendorOrder: toVendorOrderDto(updated),
    message: lookup.found
      ? null
      : `Vendor returned no status for PO ${row.poNumber} yet — this is normal shortly after submission.`,
  };
}

/**
 * Refresh every active live order (submitted/unknown, not archived),
 * sequentially — no parallel hammering of vendor SOAP endpoints.
 */
export async function refreshActiveVendorOrders(): Promise<RefreshAllResult> {
  const rows = await db
    .select()
    .from(vendorOrdersTable)
    .where(
      and(
        eq(vendorOrdersTable.mode, "live"),
        inArray(vendorOrdersTable.status, ["submitted", "unknown"]),
        eq(vendorOrdersTable.archived, false),
      ),
    )
    .orderBy(vendorOrdersTable.createdAt);

  const results: RefreshResult[] = [];
  for (const row of rows) {
    try {
      results.push(await refreshVendorOrderStatus(row.id));
    } catch (err) {
      results.push({
        outcome: "error",
        vendorOrder: toVendorOrderDto(row),
        message: `PO ${row.poNumber}: ${errMsg(err)}`,
      });
    }
  }
  return {
    checked: rows.length,
    refreshed: results.filter((r) => r.outcome === "refreshed").length,
    reconciled: results.filter((r) => r.outcome === "reconciled").length,
    noRecord: results.filter((r) => r.outcome === "no_vendor_record").length,
    errors: results.filter((r) => r.outcome === "error" || r.outcome === "not_configured")
      .length,
    results,
  };
}

/**
 * Manually resolve an UNKNOWN order as failed, releasing the anti-double-order
 * lock so the PO can be submitted again. PIN-gated at the route — this is the
 * one operation where a wrong call can cause a duplicate order, so it is
 * never automated and restricted to unknown rows only.
 */
export async function markVendorOrderFailed(
  id: string,
  note?: string | null,
): Promise<RefreshResult> {
  const [row] = await db
    .select()
    .from(vendorOrdersTable)
    .where(eq(vendorOrdersTable.id, id));
  if (!row) return { outcome: "not_found", vendorOrder: null, message: "Order not found." };
  if (row.status !== "unknown") {
    return {
      outcome: "not_refreshable",
      vendorOrder: toVendorOrderDto(row),
      message: `Only unknown orders can be manually marked failed — this one is ${row.status}.`,
    };
  }
  const reason = note?.trim()
    ? `Manually marked failed: ${note.trim()}`
    : "Manually marked failed after reconciliation (vendor has no record of the order).";
  const updated = await updateRowIfStatus(row.id, "unknown", {
    status: "failed",
    error: row.error ? `${row.error} | ${reason}` : reason,
  });
  if (!updated) {
    // A refresh reconciled the row to submitted between our read and write —
    // the vendor DOES have the order, so failing it now would be wrong.
    const [current] = await db
      .select()
      .from(vendorOrdersTable)
      .where(eq(vendorOrdersTable.id, row.id));
    return {
      outcome: "not_refreshable",
      vendorOrder: current ? toVendorOrderDto(current) : null,
      message:
        "Order status changed while marking failed (likely vendor confirmed it) — no changes made.",
    };
  }
  return {
    outcome: "refreshed",
    vendorOrder: toVendorOrderDto(updated),
    message: `Order marked failed — PO ${row.poNumber} can be submitted again.`,
  };
}
