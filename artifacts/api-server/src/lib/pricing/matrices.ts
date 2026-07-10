import {
  db,
  decorationMatricesTable,
  type DecorationMatrix as DecorationMatrixRow,
  type DecorationMatrixDataShape,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";

/**
 * Decoration pricing matrices CRUD (Price Calculator / Breezy port).
 *
 * Team-shared, no auth (same posture as every Hub route). POST is an UPSERT:
 * omit `id` to create, supply an existing (or Breezy-exported) id to update in
 * place — this lets Tyler's existing matrices import byte-for-byte.
 */

export interface DecorationMatrixDto {
  id: string;
  name: string;
  data: DecorationMatrixDataShape;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertMatrixInput {
  id?: string;
  data: DecorationMatrixDataShape;
}

export type MatrixMutationResult =
  | { status: "ok"; matrix: DecorationMatrixDto }
  | { status: "invalid"; message: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(row: DecorationMatrixRow): DecorationMatrixDto {
  return {
    id: row.id,
    name: row.name,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Semantic checks beyond the structural zod validation at the route. */
function validateData(data: DecorationMatrixDataShape): string | null {
  if (!data.name || !data.name.trim()) return "A matrix name is required";
  if (!data.xAxisLabel || !data.xAxisLabel.trim())
    return "An axis label is required";
  if (!Array.isArray(data.xValues) || data.xValues.length === 0)
    return "At least one column is required";
  for (const col of data.xValues) {
    if (!col.label || !col.label.trim()) return "Each column needs a label";
    if (!Array.isArray(col.breaks) || col.breaks.length === 0)
      return `Column "${col.label}" needs at least one quantity break`;
    for (const b of col.breaks) {
      if (!Number.isFinite(b.qty) || b.qty < 1 || !Number.isInteger(b.qty))
        return `Column "${col.label}" has an invalid quantity`;
      if (!Number.isFinite(b.decorationCost) || b.decorationCost < 0)
        return `Column "${col.label}" has an invalid decoration cost`;
    }
  }
  return null;
}

export async function listDecorationMatrices(): Promise<DecorationMatrixDto[]> {
  const rows = await db
    .select()
    .from(decorationMatricesTable)
    .orderBy(desc(decorationMatricesTable.createdAt));
  return rows.map(toDto);
}

export async function upsertDecorationMatrix(
  input: UpsertMatrixInput,
): Promise<MatrixMutationResult> {
  const invalid = validateData(input.data);
  if (invalid) return { status: "invalid", message: invalid };
  if (input.id !== undefined && !UUID_RE.test(input.id)) {
    return { status: "invalid", message: "Matrix id must be a valid UUID" };
  }

  const name = input.data.name.trim();
  const data: DecorationMatrixDataShape = { ...input.data, name };
  const now = new Date();

  if (input.id) {
    const [row] = await db
      .insert(decorationMatricesTable)
      .values({ id: input.id, name, data })
      .onConflictDoUpdate({
        target: decorationMatricesTable.id,
        set: { name, data, updatedAt: now },
      })
      .returning();
    return { status: "ok", matrix: toDto(row) };
  }

  const [row] = await db
    .insert(decorationMatricesTable)
    .values({ name, data })
    .returning();
  return { status: "ok", matrix: toDto(row) };
}

export async function deleteDecorationMatrix(
  id: string,
): Promise<"ok" | "not_found"> {
  if (!UUID_RE.test(id)) return "not_found";
  const deleted = await db
    .delete(decorationMatricesTable)
    .where(eq(decorationMatricesTable.id, id))
    .returning({ id: decorationMatricesTable.id });
  return deleted.length > 0 ? "ok" : "not_found";
}
