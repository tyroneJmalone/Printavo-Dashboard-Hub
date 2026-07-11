import type { DecorationMatrixData } from "@workspace/api-client-react";
import { resolveBreakCost } from "./matrixGrid";

/** Markup presets 1.00×–2.00× in 0.05 steps (21 values), Breezy default 1.75×. */
export const MARKUP_PRESETS: number[] = Array.from({ length: 21 }, (_, i) =>
  Number((1 + i * 0.05).toFixed(2)),
);
export const DEFAULT_MARKUP = 1.75;
export const MAX_LOCATIONS = 4;

export interface QuoteLocation {
  data: DecorationMatrixData;
  columnIndex: number;
}

export interface QuoteRow {
  qty: number;
  /** Raw garment cost per piece (same every row). */
  garmentCost: number;
  /** Markup dollars per piece: garmentCost × (markup − 1). */
  garmentMarkup: number;
  /** Marked-up garment per piece: garmentCost × markup. */
  baseCost: number;
  /** Per-piece decoration cost summed across all locations at this qty. */
  decorationCost: number;
  /** baseCost + decorationCost — unrounded; round at display only. */
  unitPrice: number;
  /** garmentCost × qty — what the blanks cost you. */
  totalGarment: number;
  /** garmentMarkup × qty — profit on the blanks. */
  totalBlankMarkup: number;
  /** decorationCost × qty. */
  totalDecoration: number;
  /** unitPrice × qty — unrounded; round at display only. */
  total: number;
}

/**
 * Breezy Quote formula: unit = (garmentCost × markup) + Σ decorationCost.
 * Result rows come from the FIRST location's selected column (canonical qty
 * tiers); every location resolves its cost at that qty via the price-break
 * rule (highest tier ≤ qty; below the lowest tier, the lowest tier applies).
 */
export function computeQuote(
  garmentCost: number,
  markup: number,
  locations: QuoteLocation[],
): QuoteRow[] {
  const valid = locations.filter(
    (l) => l.data.xValues[l.columnIndex] !== undefined,
  );
  if (valid.length === 0) return [];

  const firstCol = valid[0].data.xValues[valid[0].columnIndex];
  const tiers = [...new Set(firstCol.breaks.map((b) => b.qty))].sort(
    (a, b) => a - b,
  );
  const baseCost = garmentCost * markup;
  const garmentMarkup = baseCost - garmentCost;

  return tiers.map((qty) => {
    const decorationCost = valid.reduce(
      (sum, l) =>
        sum + resolveBreakCost(l.data.xValues[l.columnIndex].breaks, qty),
      0,
    );
    const unitPrice = baseCost + decorationCost;
    return {
      qty,
      garmentCost,
      garmentMarkup,
      baseCost,
      decorationCost,
      unitPrice,
      totalGarment: garmentCost * qty,
      totalBlankMarkup: garmentMarkup * qty,
      totalDecoration: decorationCost * qty,
      total: unitPrice * qty,
    };
  });
}
