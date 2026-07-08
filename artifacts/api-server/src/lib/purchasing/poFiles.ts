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

export interface PoFileDto {
  id: string;
  poNumber: string;
  vendorName: string;
  notes: string | null;
  totalQuantity: number;
  totalCost: number;
  lineItems: PoFileLineItem[];
  pushedToPrintavoAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: PoFileRow): PoFileDto {
  return {
    id: row.id,
    poNumber: row.poNumber,
    vendorName: row.vendorName,
    notes: row.notes,
    totalQuantity: row.totalQuantity,
    totalCost: Number(row.totalCost),
    lineItems: row.lineItems as unknown as PoFileLineItem[],
    pushedToPrintavoAt: row.pushedToPrintavoAt?.toISOString() ?? null,
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

export async function updatePoFile(
  id: string,
  patch: {
    poNumber?: string;
    notes?: string | null;
    lineItems?: PoFileLineItem[];
  },
): Promise<PoFileDto | null> {
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
  const rows = await db
    .update(poFilesTable)
    .set(set)
    .where(eq(poFilesTable.id, id))
    .returning();
  return rows[0] ? toDto(rows[0]) : null;
}

export async function deletePoFile(id: string): Promise<boolean> {
  const rows = await db
    .delete(poFilesTable)
    .where(eq(poFilesTable.id, id))
    .returning({ id: poFilesTable.id });
  return rows.length > 0;
}
