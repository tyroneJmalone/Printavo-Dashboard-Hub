import { db, poFilesTable, type PoFile as PoFileRow } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

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
  locked: boolean;
  lockReason: PoLockReason;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lock rules:
 * - Submitted to vendor → locked permanently (no unlock, ever).
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
    locked,
    lockReason,
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
    })
    .returning();
  return toDto(row);
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
