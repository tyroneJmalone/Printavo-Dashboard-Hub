import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Decoration pricing matrices (Price Calculator / Breezy port).
 *
 * A matrix is a named 2D decoration-cost table: one column per xAxis value
 * (e.g. "1 Color", "2 Colors", or a stitch count) and, within each column, a
 * list of quantity price breaks. The Price Calculator resolves a per-piece
 * decoration cost from the highest qualifying qty break of the chosen column.
 *
 * NOTE: this is the SHOP's own decoration pricing — distinct from Printavo's
 * "pricing matrix" imprint concept used in Reports (pv_imprints /
 * pricing-matrix-breakdown). Kept as its own table + `/pricing/matrices` route.
 *
 * `data` mirrors the original Breezy jsonb shape byte-for-byte so Tyler's
 * existing matrices import cleanly (POST is an upsert when `id` is supplied):
 *   { name, xAxisLabel, xValues: [{ label, breaks: [{ qty, decorationCost }] }] }
 * The top-level `name` column mirrors `data.name` for convenient listing.
 * No unique constraint on name (Breezy has none — duplicate names would break
 * a re-import).
 */
export interface DecorationBreakData {
  qty: number;
  decorationCost: number;
}

export interface DecorationColumnData {
  label: string;
  breaks: DecorationBreakData[];
}

export interface DecorationMatrixDataShape {
  name: string;
  xAxisLabel: string;
  xValues: DecorationColumnData[];
}

export const decorationMatricesTable = pgTable("decoration_matrices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  data: jsonb("data").$type<DecorationMatrixDataShape>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DecorationMatrix = typeof decorationMatricesTable.$inferSelect;
export type InsertDecorationMatrix = typeof decorationMatricesTable.$inferInsert;
