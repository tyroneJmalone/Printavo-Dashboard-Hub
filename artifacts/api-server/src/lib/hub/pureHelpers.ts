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
}): string {
  const sorted = [...opts.priceRows].sort((a, b) => a.qty - b.qty);
  const canonical = JSON.stringify({
    invoiceId: opts.invoiceId,
    visualId: opts.visualId,
    quoteNumber: opts.quoteNumber ?? null,
    rangeKey: opts.rangeKey,
    priceRows: sorted.map((r) => ({ qty: r.qty, unitPrice: r.unitPrice })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Sanitize a string for use in a public filename (no path traversal). */
export function sanitizeFilename(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
