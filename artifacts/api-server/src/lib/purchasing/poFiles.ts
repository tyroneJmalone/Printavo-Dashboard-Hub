import { randomBytes } from "node:crypto";
import { db, poFilesTable, type PoFile as PoFileRow } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { isPushActive } from "./pushRegistry";
import type { PoPushState } from "./poPush";

/**
 * Purchase order documents. Line items are jsonb snapshots — Printavo ids
 * stored as plain text (NO FKs to pv_* tables, which sync deletes+reinserts).
 * Totals are computed server-side from the per-size entries.
 */

export interface PoFileSizeEntry {
  size: string;
  qty: number;
  unitCost: number;
  sku: string | null;
  inventoryKey: string | null;
  sizeIndex: number | null;
  /** Vendor's actual size label when it differs from the Printavo `size` (e.g.
   *  SanMar's combined "S/M" stocked in the "S" column). Optional for backward
   *  compatibility — older snapshots have none. Submission sends `vendorSize ?? size`. */
  vendorSize?: string | null;
}

export interface PoFileLineItem {
  printavoLineItemId: string | null;
  printavoOrderId: string | null;
  visualId: number | null;
  styleNumber: string;
  color: string | null;
  vendorCatalogColor: string | null;
  description: string | null;
  brand: string | null;
  source: "vendor" | "manual";
  /** Warehouse the whole line ships from — optional (older POs / manual lines). */
  warehouseCode?: string | null;
  warehouseName?: string | null;
  sizes: PoFileSizeEntry[];
}

export type PoLockReason = "printavo" | "vendor" | null;

export interface PoFileDto {
  id: string;
  poNumber: string;
  vendorName: string;
  notes: string | null;
  totalQuantity: number;
  totalCost: number;
  lineItems: PoFileLineItem[];
  pushedToPrintavoAt: string | null;
  submittedToVendorAt: string | null;
  vendorOrderNumber: string | null;
  locked: boolean;
  lockReason: PoLockReason;
  pushState: PoPushState | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A push that the DB says is "running" but that this process isn't actually
 * executing was interrupted by a restart — surface it as retryable failure.
 */
function effectivePushState(row: PoFileRow): PoPushState | null {
  const raw = (row.pushState as PoPushState | null) ?? null;
  if (!raw) return null;
  // Older push cycles predate the statusSuggestions field.
  const state: PoPushState = { ...raw, statusSuggestions: raw.statusSuggestions ?? [] };
  if (state.status === "running" && !isPushActive(row.id)) {
    return {
      ...state,
      status: "failed",
      error: "Push was interrupted (server restarted) — retry to resume where it left off",
    };
  }
  return state;
}

/**
 * Lock rules:
 * - Submitted to vendor → locked; only the admin unlock (ADMIN_PIN) can
 *   remove it, which un-marks the submission entirely.
 * - Pushed to Printavo → locked, but can be manually unlocked.
 * - A future re-push to Printavo must reset manuallyUnlocked to false.
 */
function lockState(row: PoFileRow): { locked: boolean; lockReason: PoLockReason } {
  if (row.submittedToVendorAt) return { locked: true, lockReason: "vendor" };
  if (row.pushedToPrintavoAt && !row.manuallyUnlocked)
    return { locked: true, lockReason: "printavo" };
  return { locked: false, lockReason: null };
}

function toDto(row: PoFileRow): PoFileDto {
  const { locked, lockReason } = lockState(row);
  return {
    id: row.id,
    poNumber: row.poNumber,
    vendorName: row.vendorName,
    notes: row.notes,
    totalQuantity: row.totalQuantity,
    totalCost: Number(row.totalCost),
    lineItems: row.lineItems as unknown as PoFileLineItem[],
    pushedToPrintavoAt: row.pushedToPrintavoAt?.toISOString() ?? null,
    submittedToVendorAt: row.submittedToVendorAt?.toISOString() ?? null,
    vendorOrderNumber: row.vendorOrderNumber,
    locked,
    lockReason,
    pushState: effectivePushState(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function computeTotals(lineItems: PoFileLineItem[]): {
  totalQuantity: number;
  totalCost: number;
} {
  let totalQuantity = 0;
  let totalCost = 0;
  for (const li of lineItems) {
    for (const s of li.sizes) {
      totalQuantity += s.qty;
      totalCost += s.qty * s.unitCost;
    }
  }
  return { totalQuantity, totalCost: Math.round(totalCost * 100) / 100 };
}

export async function createPoFile(input: {
  poNumber: string;
  vendorName: string;
  notes?: string | null;
  lineItems: PoFileLineItem[];
}): Promise<PoFileDto> {
  const { totalQuantity, totalCost } = computeTotals(input.lineItems);
  const [row] = await db
    .insert(poFilesTable)
    .values({
      poNumber: input.poNumber,
      vendorName: input.vendorName,
      notes: input.notes ?? null,
      totalQuantity,
      totalCost: totalCost.toFixed(2),
      lineItems: input.lineItems,
      htmlToken: newHtmlToken(),
    })
    .returning();
  return toDto(row);
}

/**
 * Secret for the public PO HTML URL (the only unauthenticated endpoint).
 * Non-expiring by design — Printavo fetches the file asynchronously after
 * productionFileCreate, so an expiring link would silently break the attach.
 * A push (P3c) must regenerate it so previously shared links die.
 */
export function newHtmlToken(): string {
  return randomBytes(32).toString("hex");
}

/** Internal row lookup for the public HTML route — NOT exposed in the DTO. */
export async function getPoFileByHtmlToken(token: string): Promise<PoFileDto | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const rows = await db
    .select()
    .from(poFilesTable)
    .where(eq(poFilesTable.htmlToken, token))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export async function listPoFiles(): Promise<PoFileDto[]> {
  const rows = await db
    .select()
    .from(poFilesTable)
    .orderBy(desc(poFilesTable.createdAt));
  return rows.map(toDto);
}

export async function getPoFile(id: string): Promise<PoFileDto | null> {
  const rows = await db
    .select()
    .from(poFilesTable)
    .where(eq(poFilesTable.id, id))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export type PoMutationResult =
  | { status: "ok"; po: PoFileDto }
  | { status: "not_found" }
  | { status: "locked"; lockReason: Exclude<PoLockReason, null> };

/** Row fetched inside a transaction with FOR UPDATE so concurrent edits serialize. */
async function lockRow(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  id: string,
): Promise<PoFileRow | null> {
  const rows = await tx
    .select()
    .from(poFilesTable)
    .where(eq(poFilesTable.id, id))
    .for("update")
    .limit(1);
  return rows[0] ?? null;
}

export async function updatePoFile(
  id: string,
  patch: {
    poNumber?: string;
    notes?: string | null;
    lineItems?: PoFileLineItem[];
  },
): Promise<PoMutationResult> {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, id);
    if (!row) return { status: "not_found" as const };
    const { locked, lockReason } = lockState(row);
    if (locked) return { status: "locked" as const, lockReason: lockReason! };
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.poNumber !== undefined) set.poNumber = patch.poNumber;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.lineItems !== undefined) {
      // Line items are always replaced wholesale; totals never drift from them.
      const { totalQuantity, totalCost } = computeTotals(patch.lineItems);
      set.lineItems = patch.lineItems;
      set.totalQuantity = totalQuantity;
      set.totalCost = totalCost.toFixed(2);
      // Old push progress refers to the old lines — the next push starts a
      // fresh cycle instead of resuming against a stale line list.
      set.pushState = null;
    }
    const rows = await tx
      .update(poFilesTable)
      .set(set)
      .where(eq(poFilesTable.id, id))
      .returning();
    return { status: "ok" as const, po: toDto(rows[0]) };
  });
}

export async function appendPoFileLineItems(
  id: string,
  newLines: PoFileLineItem[],
): Promise<PoMutationResult> {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, id);
    if (!row) return { status: "not_found" as const };
    const { locked, lockReason } = lockState(row);
    if (locked) return { status: "locked" as const, lockReason: lockReason! };
    const merged = [
      ...(row.lineItems as unknown as PoFileLineItem[]),
      ...newLines,
    ];
    const { totalQuantity, totalCost } = computeTotals(merged);
    const rows = await tx
      .update(poFilesTable)
      .set({
        lineItems: merged,
        totalQuantity,
        totalCost: totalCost.toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(poFilesTable.id, id))
      .returning();
    return { status: "ok" as const, po: toDto(rows[0]) };
  });
}

export type PoSubmitToVendorResult =
  | { status: "ok"; po: PoFileDto }
  | { status: "not_found" }
  | { status: "already_submitted" };

/**
 * Mark a PO as submitted to the vendor — a PERMANENT lock on edits (pushes to
 * Printavo remain allowed; Tyler's flow is order from vendor first, push after).
 * Optionally records the vendor's order/confirmation number. One-way: there is
 * no unsubmit, so the route must warn before calling this.
 */
export async function submitPoToVendor(
  id: string,
  vendorOrderNumber: string | null,
): Promise<PoSubmitToVendorResult> {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, id);
    if (!row) return { status: "not_found" as const };
    if (row.submittedToVendorAt) return { status: "already_submitted" as const };
    const rows = await tx
      .update(poFilesTable)
      .set({
        submittedToVendorAt: new Date(),
        vendorOrderNumber,
        updatedAt: new Date(),
      })
      .where(eq(poFilesTable.id, id))
      .returning();
    return { status: "ok" as const, po: toDto(rows[0]) };
  });
}

export type PoUnlockResult =
  | { status: "ok"; po: PoFileDto }
  | { status: "not_found" }
  | { status: "vendor_locked" }
  | { status: "not_locked" };

export async function unlockPoFile(id: string): Promise<PoUnlockResult> {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, id);
    if (!row) return { status: "not_found" as const };
    if (row.submittedToVendorAt) return { status: "vendor_locked" as const };
    const { locked } = lockState(row);
    if (!locked) return { status: "not_locked" as const };
    const rows = await tx
      .update(poFilesTable)
      .set({ manuallyUnlocked: true, updatedAt: new Date() })
      .where(eq(poFilesTable.id, id))
      .returning();
    return { status: "ok" as const, po: toDto(rows[0]) };
  });
}

export type PoAdminUnlockResult =
  | { status: "ok"; po: PoFileDto }
  | { status: "not_found" }
  | { status: "not_vendor_locked" };

/**
 * Admin-only escape hatch: un-marks a mistaken "submitted to vendor" —
 * clears the timestamp and vendor order number. PIN verification happens at
 * the route layer.
 */
export async function adminUnlockVendorPoFile(
  id: string,
): Promise<PoAdminUnlockResult> {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, id);
    if (!row) return { status: "not_found" as const };
    if (!row.submittedToVendorAt) return { status: "not_vendor_locked" as const };
    const rows = await tx
      .update(poFilesTable)
      .set({
        submittedToVendorAt: null,
        vendorOrderNumber: null,
        // Leave the PO editable right away — if it was also pushed to
        // Printavo, the printavo lock would otherwise re-engage instantly.
        manuallyUnlocked: true,
        updatedAt: new Date(),
      })
      .where(eq(poFilesTable.id, id))
      .returning();
    return { status: "ok" as const, po: toDto(rows[0]) };
  });
}

export async function deletePoFile(
  id: string,
): Promise<"deleted" | "not_found" | "locked"> {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, id);
    if (!row) return "not_found" as const;
    if (lockState(row).locked) return "locked" as const;
    await tx.delete(poFilesTable).where(eq(poFilesTable.id, id));
    return "deleted" as const;
  });
}
