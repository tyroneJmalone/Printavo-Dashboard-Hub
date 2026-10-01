export interface PlateLayerOrder {
  ink: string;
  abIndex: number;
  abBase?: boolean;
}

/** Only a number at the start of the ink label is a layer number. */
export function leadingInkNumber(ink: string): number | null {
  const match = /^\s*(\d+)/.exec(ink);
  return match ? Number(match[1]) : null;
}

const compareNames = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Bottom-to-top order, shared by the swatches and rendered plates.
 * Underbase is the explicit exception to numeric ordering. Unnumbered inks
 * follow numbered inks in deterministic name order; ties use board/source order.
 */
export function sortPlateLayers<T extends PlateLayerOrder>(layers: readonly T[]): T[] {
  return layers.map((layer, sourceIndex) => ({
    layer,
    sourceIndex,
    number: leadingInkNumber(layer.ink)
  })).sort((a, b) => {
    const baseOrder = Number(Boolean(b.layer.abBase)) - Number(Boolean(a.layer.abBase));
    if (baseOrder) return baseOrder;

    if (a.number !== null && b.number !== null) {
      if (a.number !== b.number) return a.number - b.number;
    } else if (a.number !== null || b.number !== null) {
      return a.number !== null ? -1 : 1;
    } else {
      const nameOrder = compareNames(a.layer.ink.trim().toLowerCase(), b.layer.ink.trim().toLowerCase())
        || compareNames(a.layer.ink, b.layer.ink);
      if (nameOrder) return nameOrder;
    }

    return a.layer.abIndex - b.layer.abIndex || a.sourceIndex - b.sourceIndex;
  }).map(({ layer }) => layer);
}