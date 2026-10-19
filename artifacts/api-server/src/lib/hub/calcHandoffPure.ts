/**
 * Hub Price Calculator — multi-style handoff pure logic.
 *
 * No DB / network imports. Server-side recomputation of every price the
 * client reviewed, plus deterministic Printavo payload building.
 */
import { createHash } from "node:crypto";
import { toLineItemSizeEnum } from "@workspace/printavo";
import { buildLineItemDescription, rangeKeyBounds, VALID_RANGE_KEYS } from "./pureHelpers";

export type HandoffMode = "compare" | "mixed";
export const MAX_HANDOFF_GARMENTS = 12;
export const MAX_HANDOFF_DECORATIONS = 4;

export interface HandoffGarmentInput {
  id: string;
  style: string;
  color: string;
  brand: string;
  description: string;
  categoryId: string;
  garmentCost: number;
  sizes: Array<{ size: string; quantity: number }>;
}

export interface HandoffDecorationInput {
  id: string;
  placement: string;
  details: string;
  matrixId: string;
  columnIndex: number;
}

export interface HandoffPricingInput {
  mode: HandoffMode;
  markup: number;
  rangeKey: string;
  garments: HandoffGarmentInput[];
  decorations: HandoffDecorationInput[];
}

export interface HandoffMatrix {
  id: string;
  name: string;
  data: {
    xValues: Array<{ label: string; breaks: Array<{ qty: number; decorationCost: number }> }>;
  };
}

export class HandoffValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffValidationError";
  }
}

export function resolveBreakCost(
  breaks: Array<{ qty: number; decorationCost: number }>,
  quantity: number,
): number {
  const sorted = [...breaks].sort((a, b) => a.qty - b.qty);
  let resolved = sorted[0]?.decorationCost ?? 0;
  for (const priceBreak of sorted) {
    if (priceBreak.qty > quantity) break;
    resolved = priceBreak.decorationCost;
  }
  return resolved;
}

export const cents = (n: number) => Math.round(n * 100) / 100;

export function decorationDetails(d: Pick<HandoffDecorationInput, "placement" | "details">): string {
  return [d.placement.trim(), d.details.trim()].filter(Boolean).join(" — ");
}

export interface PricedGarment {
  garment: HandoffGarmentInput;
  /** Compare: full schedule. Mixed: empty. */
  schedule: Array<{ qty: number; unitPrice: number }>;
  /** Mixed only: this style's ordered quantity. */
  quantity: number;
  /** Mixed: reviewed unit price. Compare: 0 (descriptive, nothing ordered). */
  unitPrice: number;
  sizes: Array<{ size: string; count: number }>;
}

export interface PricedHandoff {
  mode: HandoffMode;
  /** Mixed only: combined quantity driving the shared decoration tier. */
  combinedQuantity: number | null;
  decorationCostPerPiece: number | null;
  garments: PricedGarment[];
}

/** Validate shape and recompute every price from Hub matrices. */
export function priceHandoff(
  input: HandoffPricingInput,
  matrices: HandoffMatrix[],
): PricedHandoff {
  if (input.mode !== "compare" && input.mode !== "mixed") {
    throw new HandoffValidationError("Choose Compare styles or Mixed order.");
  }
  if (!Number.isFinite(input.markup) || input.markup <= 0 || input.markup > 10) {
    throw new HandoffValidationError("Markup must be a positive multiplier.");
  }
  if (input.garments.length === 0 || input.garments.length > MAX_HANDOFF_GARMENTS) {
    throw new HandoffValidationError(`Add 1–${MAX_HANDOFF_GARMENTS} garment styles.`);
  }
  if (input.decorations.length === 0 || input.decorations.length > MAX_HANDOFF_DECORATIONS) {
    throw new HandoffValidationError(`Add 1–${MAX_HANDOFF_DECORATIONS} decoration placements.`);
  }
  const ids = new Set<string>();
  for (const g of input.garments) {
    if (ids.has(g.id)) throw new HandoffValidationError("Duplicate garment row id.");
    ids.add(g.id);
    for (const [field, value, max] of [
      ["style", g.style, 100],
      ["color", g.color, 100],
      ["brand", g.brand, 120],
      ["description", g.description, 500],
      ["category", g.categoryId, 40],
    ] as const) {
      if (!value.trim()) throw new HandoffValidationError(`${g.style || "Garment"}: ${field} is required.`);
      if (value.trim().length > max) throw new HandoffValidationError(`${g.style}: ${field} is too long.`);
    }
    if (!Number.isFinite(g.garmentCost) || g.garmentCost < 0) {
      throw new HandoffValidationError(`${g.style}: garment cost must be a number of 0 or more.`);
    }
  }
  const byId = new Map(matrices.map((m) => [m.id, m]));
  const columns = input.decorations.map((d) => {
    if (!d.placement.trim()) throw new HandoffValidationError("Every decoration needs a placement (e.g. Left Chest).");
    if (d.placement.length > 80 || d.details.length > 300) {
      throw new HandoffValidationError(`${d.placement}: placement or details too long.`);
    }
    const matrix = byId.get(d.matrixId);
    if (!matrix) throw new HandoffValidationError(`${d.placement}: the selected Hub pricing matrix no longer exists.`);
    const column = matrix.data.xValues[d.columnIndex];
    if (!column || column.breaks.length === 0) {
      throw new HandoffValidationError(`${d.placement}: the selected column in "${matrix.name}" no longer exists.`);
    }
    return column;
  });

  if (input.mode === "compare") {
    if (!VALID_RANGE_KEYS.has(input.rangeKey)) throw new HandoffValidationError("Invalid quantity range.");
    const { lo, hi } = rangeKeyBounds(input.rangeKey);
    const tiers = [...new Set(columns[0]!.breaks.map((b) => b.qty))]
      .sort((a, b) => a - b)
      .filter((q) => q >= lo && q <= hi);
    if (tiers.length === 0) throw new HandoffValidationError("The selected range has no pricing tiers.");
    return {
      mode: "compare",
      combinedQuantity: null,
      decorationCostPerPiece: null,
      garments: input.garments.map((garment) => {
        if (garment.sizes.some((s) => s.quantity > 0)) {
          throw new HandoffValidationError(
            `${garment.style}: Compare styles never sends ordered quantities. Switch to Mixed order to send sizes.`,
          );
        }
        const base = garment.garmentCost * input.markup;
        return {
          garment,
          schedule: tiers.map((qty) => ({
            qty,
            unitPrice: cents(base + columns.reduce((s, c) => s + resolveBreakCost(c.breaks, qty), 0)),
          })),
          quantity: 0,
          unitPrice: 0,
          sizes: [],
        };
      }),
    };
  }

  let combined = 0;
  const sized = input.garments.map((garment) => {
    const seen = new Set<string>();
    const sizes = garment.sizes
      .filter((s) => s.quantity !== 0)
      .map((s) => {
        if (!Number.isInteger(s.quantity) || s.quantity < 0 || s.quantity > 100000) {
          throw new HandoffValidationError(`${garment.style} ${s.size}: quantity must be a whole number.`);
        }
        const size = toLineItemSizeEnum(s.size);
        if (!size) throw new HandoffValidationError(`${garment.style}: ${s.size} is not a Printavo size.`);
        if (seen.has(size)) throw new HandoffValidationError(`${garment.style}: ${s.size} is listed twice.`);
        seen.add(size);
        return { size, count: s.quantity };
      });
    const quantity = sizes.reduce((sum, s) => sum + s.count, 0);
    if (quantity <= 0) {
      throw new HandoffValidationError(`${garment.style}: enter a size breakdown (Mixed order needs real quantities).`);
    }
    combined += quantity;
    return { garment, sizes, quantity };
  });
  const decorationCost = columns.reduce((s, c) => s + resolveBreakCost(c.breaks, combined), 0);
  return {
    mode: "mixed",
    combinedQuantity: combined,
    decorationCostPerPiece: cents(decorationCost),
    garments: sized.map(({ garment, sizes, quantity }) => ({
      garment,
      schedule: [],
      quantity,
      unitPrice: cents(garment.garmentCost * input.markup + decorationCost),
      sizes,
    })),
  };
}

export interface HandoffLine {
  garmentId: string;
  categoryId: string;
  categoryName: string;
  itemNumber: string;
  color: string;
  description: string;
  price: number;
  sizes: Array<{ size: string; count: number }>;
  quantity: number;
}

export function buildHandoffLines(
  priced: PricedHandoff,
  categoryNames: Map<string, string>,
): HandoffLine[] {
  return priced.garments.map(({ garment, schedule, unitPrice, sizes, quantity }) => {
    const description =
      priced.mode === "compare"
        ? buildLineItemDescription(garment, schedule)
        : `${garment.brand.trim()} ${garment.description.trim()}`.trim();
    return {
      garmentId: garment.id,
      categoryId: garment.categoryId.trim(),
      categoryName: categoryNames.get(garment.categoryId.trim()) ?? "",
      itemNumber: garment.style.trim(),
      color: garment.color.trim(),
      description,
      price: unitPrice,
      sizes,
      quantity,
    };
  });
}

/** Mixed mode: every client-reviewed unit price must equal the server recompute. */
export function assertReviewedPrices(
  priced: PricedHandoff,
  reviewed: Array<{ garmentId: string; unitPrice: number }> | undefined,
): void {
  if (priced.mode !== "mixed") return;
  for (const g of priced.garments) {
    const r = reviewed?.find((x) => x.garmentId === g.garment.id);
    if (!r || cents(r.unitPrice) !== g.unitPrice) {
      throw new HandoffValidationError(
        `${g.garment.style}: the reviewed unit price no longer matches the current matrices ($${g.unitPrice.toFixed(2)}). Review again.`,
      );
    }
  }
}

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function snapshotHash(snapshot: unknown): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/**
 * Stable dedupe identity: the snapshot minus the derived append position.
 * After a successful (or ambiguous) append the live group count changes, so
 * the full preview hash changes; this key does not.
 */
export function operationKey(snapshot: { target: object; lines?: HandoffLine[] }): string {
  const { groupPosition: _ignored, ...target } = snapshot.target as Record<string, unknown>;
  // Row ids are browser-local; recreating a worksheet must not evade a hold.
  const lines = snapshot.lines?.map(({ garmentId: _rowId, ...line }) => line);
  return snapshotHash({ ...snapshot, target, ...(lines ? { lines } : {}) });
}

/** Canonical digest of the client request (excluding the preview binding). */
export function requestDigest(req: object): string {
  const { expectedSnapshotHash: _ignored, ...rest } = req as Record<string, unknown>;
  return snapshotHash(rest);
}

/** Strict calendar date: YYYY-MM-DD that round-trips (rejects 2026-02-30). */
export function isStrictIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
