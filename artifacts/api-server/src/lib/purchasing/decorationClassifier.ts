/**
 * Pure decoration classification shared by Purchasing and auto-print.
 *
 * The line-item category is the source of truth for production decoration.
 * Imprints are deliberately not consulted here: an order can have a valid
 * decoration category even when its imprints are empty or were not synced.
 */

export type DecoGroup = "print" | "heat" | "embroidery";
export type DecorationKind = DecoGroup | "mixed";

export const DECO_GROUPS: readonly DecoGroup[] = [
  "print",
  "heat",
  "embroidery",
];

/** Stable labels used by the auto-print destination editor/API. */
export const DECORATION_CATEGORY_LABELS = [
  "Screen Printing",
  "Heat Applied Graphics",
  "Embroidery",
  "Mixed Decoration",
] as const;

/**
 * Keep this line-category map aligned with Purchasing's original
 * CATEGORY_TO_GROUP. Aliases below are for saved auto-print destination
 * mappings only; adding aliases here would change Purchasing matching.
 */
const LINE_CATEGORY_TO_GROUP: Readonly<Record<string, DecoGroup>> = {
  "screen printing": "print",
  "heat applied graphics": "heat",
  "heat applied graphics - personalizations": "heat",
  embroidery: "embroidery",
  "embroidery - personalizations": "embroidery",
  "embroidery - set up/digitizing": "embroidery",
};

const CATEGORY_ALIASES: Readonly<Record<string, DecoGroup>> = {
  "screen print": "print",
  screenprinting: "print",
  "screen prints": "print",
  silkscreen: "print",
  "silk screen": "print",
  sp: "print",
  "heat applied graphic": "heat",
  "heat applied graphics - personalization": "heat",
  "heat applied": "heat",
  "heat press": "heat",
  dtf: "heat",
  "embroidery - personalization": "embroidery",
  "embroidery - setup/digitizing": "embroidery",
  "embroidery - set up": "embroidery",
  "embroidery - digitizing": "embroidery",
  emb: "embroidery",
};

const MIXED_CATEGORY_ALIASES = new Set([
  "mixed decoration",
  "mixed decorations",
]);

export interface DecorationLine {
  categoryName: string | null;
  /**
   * Quantity represented by this line. A missing/non-positive quantity is
   * ignored when positiveQuantityOnly is requested.
   */
  items?: number | null;
}

export interface DecorationClassification {
  groups: Set<DecoGroup>;
  mixed: boolean;
  /** null for no recognized positive-quantity decoration lines. */
  kind: DecorationKind | null;
}

export interface DecorationDestinationMapping {
  category: string;
  statusId: string;
  statusName: string;
}

export function normalizeDecorationCategory(name: string | null | undefined): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ");
}

/**
 * Resolve a saved mapping or a line-item category to its destination group.
 * Unknown values intentionally return null: accepting arbitrary substrings
 * would silently route future categories to the wrong destination.
 */
export function decorationGroupForCategory(
  category: string | null | undefined,
): DecoGroup | null {
  const normalized = normalizeDecorationCategory(category);
  return LINE_CATEGORY_TO_GROUP[normalized] ?? CATEGORY_ALIASES[normalized] ?? null;
}

export function decorationKindForCategory(
  category: string | null | undefined,
): DecorationKind | null {
  const normalized = normalizeDecorationCategory(category);
  if (MIXED_CATEGORY_ALIASES.has(normalized)) return "mixed";
  return LINE_CATEGORY_TO_GROUP[normalized] ?? CATEGORY_ALIASES[normalized] ?? null;
}

function lineDecorationKind(
  category: string | null | undefined,
): DecorationKind | null {
  // This intentionally mirrors Purchasing's historical trim + lowercase
  // normalization instead of broadening its line-category matches.
  const normalized = (category ?? "").trim().toLowerCase();
  if (normalized === "mixed decoration") return "mixed";
  return LINE_CATEGORY_TO_GROUP[normalized] ?? null;
}

/**
 * Classify recognized decoration lines. Purchasing passes the historical
 * include-zero behavior (the default) to preserve its existing semantics;
 * auto-print requests positiveQuantityOnly so stale zero-quantity rows cannot
 * route an order.
 */
export function classifyDecorationLines(
  lines: readonly DecorationLine[],
  options: { positiveQuantityOnly?: boolean } = {},
): DecorationClassification {
  const groups = new Set<DecoGroup>();
  let explicitMixed = false;

  for (const line of lines) {
    if (options.positiveQuantityOnly && !(line.items != null && line.items > 0)) {
      continue;
    }
    const kind = lineDecorationKind(line.categoryName);
    if (kind === "mixed") {
      explicitMixed = true;
    } else if (kind) {
      groups.add(kind);
    }
  }

  const mixed = explicitMixed || groups.size > 1;
  const kind: DecorationKind | null = mixed
    ? "mixed"
    : groups.size === 1
      ? [...groups][0]
      : null;
  return { groups, mixed, kind };
}

/**
 * Select the first saved destination mapping for the exact classified kind.
 * This deliberately does not fall back from mixed to a single-method
 * mapping, and unknown saved categories never match.
 */
export function destinationMappingForClassification<
  T extends DecorationDestinationMapping,
>(
  classification: DecorationClassification,
  mappings: readonly T[],
): T | null {
  if (!classification.kind) return null;
  for (const mapping of mappings) {
    if (decorationKindForCategory(mapping.category) === classification.kind) {
      return mapping;
    }
  }
  return null;
}