/** Share of the full filtered report, never the sum of overlapping group rows. */
export function reportShare(value: number, total: number): number {
  return Number.isFinite(value) && Number.isFinite(total) && total > 0
    ? (value / total) * 100
    : 0;
}
