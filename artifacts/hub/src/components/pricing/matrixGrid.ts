import type {
  DecorationMatrixData,
  DecorationBreak,
} from "@workspace/api-client-react";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

/** Highest break whose qty <= target; below the lowest tier, fall back to the lowest. */
export function resolveBreakCost(
  breaks: DecorationBreak[],
  qty: number,
): number {
  if (breaks.length === 0) return 0;
  const sorted = [...breaks].sort((a, b) => a.qty - b.qty);
  let chosen = sorted[0];
  for (const b of sorted) {
    if (b.qty <= qty) chosen = b;
    else break;
  }
  return chosen.decorationCost;
}

export interface MatrixGrid {
  name: string;
  xAxisLabel: string;
  columns: string[];
  tiers: number[];
  /** costs[tierIndex][columnIndex] */
  costs: number[][];
}

/**
 * Reconstruct a 2D grid (shared qty tiers × columns) from the stored per-column
 * shape. Screen-print / embroidery matrices share tiers across columns, so the
 * union of qtys yields a clean rectangular grid.
 */
export function toGrid(data: DecorationMatrixData): MatrixGrid {
  const columns = data.xValues.map((x) => x.label);
  const tierSet = new Set<number>();
  for (const col of data.xValues) for (const b of col.breaks) tierSet.add(b.qty);
  const tiers = [...tierSet].sort((a, b) => a - b);
  const costs = tiers.map((t) =>
    data.xValues.map((col) => {
      const exact = col.breaks.find((b) => b.qty === t);
      return exact ? exact.decorationCost : resolveBreakCost(col.breaks, t);
    }),
  );
  return { name: data.name, xAxisLabel: data.xAxisLabel, columns, tiers, costs };
}

/** Build the stored per-column shape from an edited grid. */
export function fromGrid(grid: MatrixGrid): DecorationMatrixData {
  const order = grid.tiers
    .map((qty, i) => ({ qty, i }))
    .sort((a, b) => a.qty - b.qty);
  return {
    name: grid.name.trim(),
    xAxisLabel: grid.xAxisLabel.trim(),
    xValues: grid.columns.map((label, ci) => ({
      label: label.trim(),
      breaks: order.map(({ qty, i }) => ({
        qty,
        decorationCost: grid.costs[i][ci],
      })),
    })),
  };
}

/** Two illustrative starter matrices for a fresh install. */
export function starterMatrices(): DecorationMatrixData[] {
  return [
    {
      name: "Screen Print — by Colors",
      xAxisLabel: "Colors",
      xValues: [
        {
          label: "1 Color",
          breaks: [
            { qty: 24, decorationCost: 3.5 },
            { qty: 48, decorationCost: 2.75 },
            { qty: 72, decorationCost: 2.25 },
            { qty: 144, decorationCost: 1.85 },
          ],
        },
        {
          label: "2 Colors",
          breaks: [
            { qty: 24, decorationCost: 4.75 },
            { qty: 48, decorationCost: 3.75 },
            { qty: 72, decorationCost: 3.0 },
            { qty: 144, decorationCost: 2.5 },
          ],
        },
        {
          label: "3 Colors",
          breaks: [
            { qty: 24, decorationCost: 5.75 },
            { qty: 48, decorationCost: 4.5 },
            { qty: 72, decorationCost: 3.75 },
            { qty: 144, decorationCost: 3.1 },
          ],
        },
      ],
    },
    {
      name: "Embroidery — by Stitches",
      xAxisLabel: "Stitches",
      xValues: [
        {
          label: "Up to 5k",
          breaks: [
            { qty: 24, decorationCost: 5.5 },
            { qty: 48, decorationCost: 4.75 },
            { qty: 72, decorationCost: 4.25 },
          ],
        },
        {
          label: "5k – 10k",
          breaks: [
            { qty: 24, decorationCost: 7.0 },
            { qty: 48, decorationCost: 6.0 },
            { qty: 72, decorationCost: 5.25 },
          ],
        },
      ],
    },
  ];
}
