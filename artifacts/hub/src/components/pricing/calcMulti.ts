import type { DecorationMatrix, HubCalculatorHandoffRequest } from "@workspace/api-client-react";
import { computeQuote, type QuoteRow } from "./calcEngine";
import { resolveBreakCost } from "./matrixGrid";
import type { VendorPriceMode, VendorPriceSelection } from "./VendorPriceChoice";

export type PricingMode = "compare" | "mixed";

export const SIZE_COLUMNS = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"] as const;

export const PLACEMENT_PRESETS = [
  "Left Chest",
  "Right Chest",
  "Full Front",
  "Full Back",
  "Upper Back",
  "Nape",
  "Left Sleeve",
  "Right Sleeve",
  "Hat Front",
  "Hat Side",
  "Pocket",
];

export interface GarmentRow {
  id: string;
  style: string;
  color: string;
  brand: string;
  description: string;
  costStr: string;
  vendorSelection: VendorPriceSelection | null;
  vendorMode: VendorPriceMode | null;
  categoryId: string;
  /** Mixed order only — per-size quantity strings. */
  sizes: Record<string, string>;
}

export interface DecorationRow {
  id: string;
  placement: string;
  details: string;
  matrixId: string;
  columnIndex: number;
}

let seq = 0;
export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function emptyGarment(cost = ""): GarmentRow {
  return {
    id: newId("g"),
    style: "",
    color: "",
    brand: "",
    description: "",
    costStr: cost,
    vendorSelection: null,
    vendorMode: null,
    categoryId: "",
    sizes: {},
  };
}

export function defaultPlacement(index: number): string {
  return ["Left Chest", "Full Back", "Left Sleeve", "Right Sleeve"][index] ?? "";
}

export function emptyDecoration(index: number): DecorationRow {
  return { id: newId("d"), placement: defaultPlacement(index), details: "", matrixId: "", columnIndex: 0 };
}

export function garmentCost(row: GarmentRow): number | null {
  if (row.costStr.trim() === "") return null;
  const n = Number(row.costStr);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function garmentLabel(row: GarmentRow, index: number): string {
  return [row.brand, row.style, row.color].filter((v) => v.trim()).join(" · ") || `Style ${index + 1}`;
}

export function sizeQty(row: GarmentRow): number {
  return SIZE_COLUMNS.reduce((sum, size) => {
    const n = Number(row.sizes[size] ?? "");
    return sum + (Number.isInteger(n) && n > 0 ? n : 0);
  }, 0);
}

export function sizesValid(row: GarmentRow): boolean {
  return SIZE_COLUMNS.every((size) => {
    const raw = (row.sizes[size] ?? "").trim();
    if (!raw) return true;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0;
  });
}

export interface ValidDecoration {
  row: DecorationRow;
  matrix: DecorationMatrix;
}

export function validDecorations(rows: DecorationRow[], byId: Map<string, DecorationMatrix>): ValidDecoration[] {
  return rows.flatMap((row) => {
    const matrix = byId.get(row.matrixId);
    if (!matrix || matrix.data.xValues[row.columnIndex] === undefined) return [];
    return [{ row, matrix }];
  });
}

export function compareSchedule(
  row: GarmentRow,
  markup: number,
  decorations: ValidDecoration[],
): QuoteRow[] {
  const cost = garmentCost(row);
  if (cost === null) return [];
  return computeQuote(
    cost,
    markup,
    decorations.map((d) => ({ data: d.matrix.data, columnIndex: d.row.columnIndex })),
  );
}

export interface MixedLine {
  garment: GarmentRow;
  qty: number;
  garmentCost: number;
  baseCost: number;
  decorationCost: number;
  unitPrice: number;
  total: number;
}

export interface MixedSummary {
  combinedQty: number;
  decorationCost: number;
  lines: MixedLine[];
  total: number;
}

export const cents = (n: number) => Math.round(n * 100) / 100;

/** Combined total sets the shared decoration tier; garment cost stays per style. */
export function mixedSummary(
  garments: GarmentRow[],
  markup: number,
  decorations: ValidDecoration[],
): MixedSummary | null {
  if (decorations.length === 0) return null;
  const combinedQty = garments.reduce((s, g) => s + sizeQty(g), 0);
  if (combinedQty <= 0) return null;
  const decorationCost = decorations.reduce(
    (s, d) => s + resolveBreakCost(d.matrix.data.xValues[d.row.columnIndex].breaks, combinedQty),
    0,
  );
  const lines = garments.flatMap((garment) => {
    const cost = garmentCost(garment);
    const qty = sizeQty(garment);
    if (cost === null || qty <= 0) return [];
    const baseCost = cost * markup;
    const unitPrice = cents(baseCost + decorationCost);
    return [{ garment, qty, garmentCost: cost, baseCost, decorationCost, unitPrice, total: unitPrice * qty }];
  });
  return { combinedQty, decorationCost, lines, total: lines.reduce((s, l) => s + l.total, 0) };
}

export function buildHandoffRequest(opts: {
  mode: PricingMode;
  markup: number;
  rangeKey: string;
  garments: GarmentRow[];
  decorations: ValidDecoration[];
  target:
    | { kind: "existing"; orderId: string }
    | { kind: "new_quote"; customerId: string; contactId: string; nickname: string; dueDate: string };
  mixed: MixedSummary | null;
}): HubCalculatorHandoffRequest {
  const base: HubCalculatorHandoffRequest = {
    mode: opts.mode,
    markup: opts.markup,
    rangeKey: opts.rangeKey,
    garments: opts.garments.map((g) => ({
      id: g.id,
      style: g.style.trim(),
      color: g.color.trim(),
      brand: g.brand.trim(),
      description: g.description.trim(),
      categoryId: g.categoryId,
      garmentCost: garmentCost(g) ?? -1,
      sizes:
        opts.mode === "mixed"
          ? SIZE_COLUMNS.filter((s) => Number(g.sizes[s] ?? "") > 0).map((s) => ({
              size: s,
              quantity: Number(g.sizes[s]),
            }))
          : [],
    })),
    decorations: opts.decorations.map((d) => ({
      id: d.row.id,
      placement: d.row.placement.trim(),
      details: d.row.details.trim(),
      matrixId: d.row.matrixId,
      columnIndex: d.row.columnIndex,
    })),
    targetKind: opts.target.kind,
    reviewedUnitPrices:
      opts.mode === "mixed" && opts.mixed
        ? opts.mixed.lines.map((l) => ({ garmentId: l.garment.id, unitPrice: l.unitPrice }))
        : [],
  };
  if (opts.target.kind === "existing") return { ...base, orderId: opts.target.orderId };
  return {
    ...base,
    customerId: opts.target.customerId,
    contactId: opts.target.contactId,
    nickname: opts.target.nickname.trim(),
    dueDate: opts.target.dueDate,
  };
}

/** Human-readable blockers before a line-item handoff can be previewed. */
export function handoffBlockers(opts: {
  mode: PricingMode;
  garments: GarmentRow[];
  decorations: DecorationRow[];
  valid: ValidDecoration[];
  mixed: MixedSummary | null;
}): string[] {
  const out: string[] = [];
  if (opts.valid.length === 0 || opts.valid.length !== opts.decorations.length) {
    out.push("Every decoration needs a valid matrix and column.");
  }
  if (opts.decorations.some((d) => !d.placement.trim())) out.push("Every decoration needs a placement.");
  opts.garments.forEach((g, i) => {
    const label = garmentLabel(g, i);
    if (garmentCost(g) === null) out.push(`${label}: enter a garment cost.`);
    if (!g.style.trim() || !g.color.trim() || !g.brand.trim() || !g.description.trim()) {
      out.push(`${label}: style, color, brand and description are required.`);
    }
    if (!g.categoryId) out.push(`${label}: choose a Printavo category.`);
    if (opts.mode === "mixed") {
      if (!sizesValid(g)) out.push(`${label}: size quantities must be whole numbers.`);
      else if (sizeQty(g) <= 0) out.push(`${label}: enter a size breakdown.`);
    }
  });
  return out;
}
