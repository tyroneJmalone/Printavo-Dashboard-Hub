/**
 * Hub Price Calculator — pure helper functions.
 *
 * No imports from DB, GCS, Printavo, or any infrastructure. Safe to import
 * directly in tests and in the route layer without side-effects.
 */

import { createHash } from "node:crypto";

/** Valid range keys — also used for validation in routes. */
export const VALID_RANGE_KEYS = new Set([
  "all",
  "12-48",
  "36-72",
  "60-96",
  "84-120",
  "108-144",
  "144-288",
]);

/** Parse inclusive [lo, hi] from a range key, or [1, Infinity] for "all". */
export function rangeKeyBounds(rangeKey: string): { lo: number; hi: number } {
  if (rangeKey === "all") return { lo: 1, hi: Infinity };
  const [loStr, hiStr] = rangeKey.split("-");
  return { lo: Number(loStr), hi: Number(hiStr) };
}

/**
 * Validate a set of price rows:
 * - Non-empty
 * - Each qty >= 1, integer, finite
 * - Each unitPrice >= 0, finite
 * - Unique qtys
 * - Sorted ascending by qty
 * - All qtys within the range key's inclusive bounds
 *
 * Returns null on success, or an error message string on failure.
 */
export function validatePriceRows(
  rows: Array<{ qty: number; unitPrice: number }>,
  rangeKey: string,
): string | null {
  if (!VALID_RANGE_KEYS.has(rangeKey)) {
    return `Invalid rangeKey "${rangeKey}"`;
  }
  if (rows.length === 0) return "priceRows must not be empty";
  const { lo, hi } = rangeKeyBounds(rangeKey);
  const qtys = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!Number.isInteger(r.qty) || r.qty < 1) {
      return `Row ${i}: qty must be a positive integer`;
    }
    if (!Number.isFinite(r.unitPrice) || r.unitPrice < 0) {
      return `Row ${i}: unitPrice must be a finite number >= 0`;
    }
    if (qtys.has(r.qty)) {
      return `Row ${i}: duplicate qty ${r.qty}`;
    }
    if (r.qty < lo || r.qty > hi) {
      return `Row ${i}: qty ${r.qty} is outside the range "${rangeKey}" (${lo}–${hi === Infinity ? "∞" : hi})`;
    }
    qtys.add(r.qty);
  }
  // Must be sorted ascending
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.qty <= rows[i - 1]!.qty) {
      return "priceRows must be sorted ascending by qty";
    }
  }
  return null;
}

/**
 * Canonical dedupe hash: SHA-256 of a deterministic JSON representation.
 * invoiceId + visualId + quoteNumber + rangeKey + rows sorted by qty.
 */
export function computeDedupeKey(opts: {
  invoiceId: string;
  visualId: number;
  quoteNumber: string | null;
  rangeKey: string;
  priceRows: Array<{ qty: number; unitPrice: number }>;
  lineItem?: {
    categoryId: string;
    itemNumber: string;
    color: string;
    brand: string;
    description: string;
  } | null;
}): string {
  const sorted = [...opts.priceRows].sort((a, b) => a.qty - b.qty);
  const canonical = JSON.stringify({
    invoiceId: opts.invoiceId,
    visualId: opts.visualId,
    quoteNumber: opts.quoteNumber ?? null,
    rangeKey: opts.rangeKey,
    priceRows: sorted.map((r) => ({ qty: r.qty, unitPrice: r.unitPrice })),
    lineItem: opts.lineItem ? normalizeLineItemInput(opts.lineItem) : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface HubCalculatorLineItemInput {
  categoryId: string;
  itemNumber: string;
  color: string;
  brand: string;
  description: string;
}

/** Stable field order + trimmed values for hashing, storage, comparison, and writes. */
export function normalizeLineItemInput(
  input: HubCalculatorLineItemInput,
): HubCalculatorLineItemInput {
  return {
    categoryId: input.categoryId.trim(),
    itemNumber: input.itemNumber.trim(),
    color: input.color.trim(),
    brand: input.brand.trim(),
    description: input.description.trim(),
  };
}

export function validateLineItemInput(
  input: HubCalculatorLineItemInput,
): string | null {
  const fields: Array<[keyof HubCalculatorLineItemInput, number]> = [
    ["categoryId", 40],
    ["itemNumber", 100],
    ["color", 100],
    ["brand", 120],
    ["description", 500],
  ];
  for (const [field, max] of fields) {
    const value = input[field].trim();
    if (!value) return `${field} is required when adding a line item`;
    if (value.length > max) return `${field} must be ${max} characters or fewer`;
  }
  return null;
}

/**
 * Printavo line-item description requested by staff:
 * product description including brand, blank line, then concise price breaks.
 */
export function buildLineItemDescription(
  input: Pick<HubCalculatorLineItemInput, "brand" | "description">,
  priceRows: Array<{ qty: number; unitPrice: number }>,
): string {
  const product = `${input.brand.trim()} ${input.description.trim()}`.trim();
  const rows = priceRows.map(
    (row) => `${row.qty}+ = $${row.unitPrice.toFixed(2)}`,
  );
  return [product, "", "QTY = PRICE", ...rows].join("\n");
}

/** Sanitize a string for use in a public filename (no path traversal). */
export function sanitizeFilename(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
