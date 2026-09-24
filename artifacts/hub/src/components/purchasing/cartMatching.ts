export type ColorMatch =
  | { kind: "exact" | "normalized"; value: string }
  | { kind: "ambiguous" | "none"; value: null };

function normalizedColor(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

const COLOR_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  dk: "dark",
  lt: "light",
  hthr: "heather",
  gry: "gray",
  grey: "gray",
  grn: "green",
};

const PROTECTED_COLOR_MODIFIERS = new Set([
  "dark",
  "light",
  "heather",
  "solid",
]);

function colorTokens(value: string): string[] {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => COLOR_TOKEN_ALIASES[token] ?? token);
}

function aliasedColor(value: string): string {
  return colorTokens(value).join(" ");
}

function modifierSignature(tokens: readonly string[]): string {
  return [...PROTECTED_COLOR_MODIFIERS].filter((token) => tokens.includes(token)).join("|");
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

/**
 * Find a color without guessing. High-confidence punctuation/spacing and common
 * abbreviation matches are accepted only when unique. A bounded typo match
 * additionally needs a clear margin over the runner-up. Meaningful modifiers
 * never disappear: Black cannot auto-match Black Heather, nor Light to Dark.
 */
export function findReusableColorMatch(
  printavoColor: string | null,
  vendorColors: readonly string[],
): ColorMatch {
  const source = printavoColor?.trim();
  if (!source) return { kind: "none", value: null };

  const exact = vendorColors.filter(
    (candidate) => candidate.trim().toLocaleLowerCase() === source.toLocaleLowerCase(),
  );
  if (exact.length === 1) return { kind: "exact", value: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", value: null };

  const normalized = normalizedColor(source);
  if (!normalized) return { kind: "none", value: null };
  const approximate = vendorColors.filter(
    (candidate) => normalizedColor(candidate) === normalized,
  );
  if (approximate.length === 1) return { kind: "normalized", value: approximate[0] };
  if (approximate.length > 1) return { kind: "ambiguous", value: null };

  const sourceTokens = colorTokens(source);
  const sourceAliased = sourceTokens.join(" ");
  const sourceModifiers = modifierSignature(sourceTokens);
  const aliasMatches = vendorColors.filter((candidate) => {
    const tokens = colorTokens(candidate);
    return (
      modifierSignature(tokens) === sourceModifiers &&
      tokens.join(" ") === sourceAliased
    );
  });
  if (aliasMatches.length === 1) return { kind: "normalized", value: aliasMatches[0] };
  if (aliasMatches.length > 1) return { kind: "ambiguous", value: null };

  const ranked = vendorColors
    .map((candidate) => {
      const candidateTokens = colorTokens(candidate);
      return {
        candidate,
        candidateTokens,
        distance: editDistance(sourceAliased, aliasedColor(candidate)),
      };
    })
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  const best = ranked[0];
  if (!best) return { kind: "none", value: null };

  const sameModifiers =
    modifierSignature(best.candidateTokens) === sourceModifiers;
  const longerLength = Math.max(sourceAliased.length, aliasedColor(best.candidate).length);
  const maximumDistance = longerLength >= 9 ? 2 : longerLength >= 5 ? 1 : 0;
  const runnerUp = ranked[1];
  const hasClearMargin = !runnerUp || runnerUp.distance - best.distance >= 2;
  if (
    sameModifiers &&
    best.distance <= maximumDistance &&
    hasClearMargin
  ) {
    return { kind: "normalized", value: best.candidate };
  }

  const sourceBase = sourceTokens
    .filter((token) => !PROTECTED_COLOR_MODIFIERS.has(token))
    .join(" ");
  const modifierConflict = ranked.some(({ candidateTokens }) => {
    const candidateBase = candidateTokens
      .filter((token) => !PROTECTED_COLOR_MODIFIERS.has(token))
      .join(" ");
    return candidateBase === sourceBase &&
      modifierSignature(candidateTokens) !== sourceModifiers;
  });
  const closeButUncertain =
    best.distance <= Math.max(2, maximumDistance + 1);
  return {
    kind: modifierConflict || closeButUncertain ? "ambiguous" : "none",
    value: null,
  };
}

// Printavo stores the catch-all one-size column as size_other. The purchasing
// endpoint strips size_, so real one-size lines (including S&S SP08) arrive as
// OTHER. This remains conservative: OTHER can map only when the selected vendor
// color has exactly one recognized one-size offer.
const GENERIC_QUANTITY_LABELS = new Set(["QUANTITY", "QUANTITIY", "OTHER"]);
const ONE_SIZE_LABELS = new Set([
  "ONE SIZE",
  "ONE SIZE FITS ALL",
  "ONE SIZE FITS MOST",
  "OSFA",
  "OSFM",
  "OS",
  "O/S",
]);

const labelKey = (value: string) =>
  value.trim().toLocaleUpperCase().replace(/\s+/g, " ");

export function isGenericQuantitySize(value: string): boolean {
  return GENERIC_QUANTITY_LABELS.has(labelKey(value));
}

export function isVendorOneSize(value: string): boolean {
  return ONE_SIZE_LABELS.has(labelKey(value));
}

/**
 * Printavo sometimes puts a product's count in a Quantity/Quantitiy column.
 * It may map to one-size only when the vendor returned one unique one-size
 * offer. The offer itself is returned so its exact label/SKU can be snapshotted.
 */
export function findUniqueOneSizeOffer<T extends { size: string }>(
  printavoSize: string,
  offers: readonly T[],
): T | null {
  if (!isGenericQuantitySize(printavoSize)) return null;
  const candidates = offers.filter((offer) => isVendorOneSize(offer.size));
  return candidates.length === 1 ? candidates[0] : null;
}

/** Deterministic PO suggestion from each contributing Printavo invoice. */
export function suggestedPoNumber(
  invoices: readonly { printavoOrderId: string; visualId: number }[],
): string {
  const distinct = new Map<string, number>();
  for (const invoice of invoices) {
    if (!distinct.has(invoice.printavoOrderId)) {
      distinct.set(invoice.printavoOrderId, invoice.visualId);
    }
  }
  return [...distinct.entries()]
    .sort(([idA, visualA], [idB, visualB]) => visualA - visualB || idA.localeCompare(idB))
    .map(([, visualId]) => String(Math.max(0, Math.trunc(visualId))).padStart(3, "0").slice(-3))
    .join("");
}

export const SANMAR_PO_NUMBER_MAX_LENGTH = 12;

export function sanmarPoNumberTooLong(poNumber: string): boolean {
  return poNumber.trim().length > SANMAR_PO_NUMBER_MAX_LENGTH;
}