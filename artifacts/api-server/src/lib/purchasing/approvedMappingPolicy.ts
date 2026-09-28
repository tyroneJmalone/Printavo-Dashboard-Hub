import type { VendorLookupResult } from "./vendorLookup";

/** Preserve punctuation and color identity; do not collapse families or style numbers. */
export function normalizeMappingSource(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function verifiedMappingTarget(
  input: { vendor: string; vendorStyleId: string | null; vendorStyle: string; vendorColor: string },
  result: VendorLookupResult,
): { vendorStyleId: string | null; vendorStyle: string; vendorColor: string } | null {
  if (!result.found || result.vendor !== input.vendor || !result.styleName) return null;
  // A fuzzy lookup is never permission to save a different garment.
  if (normalizeMappingSource(result.styleName) !== normalizeMappingSource(input.vendorStyle)) return null;
  if (result.styleId !== input.vendorStyleId) return null;
  if (input.vendor === "ss" && !input.vendorStyleId) return null;
  // Color must be the actual selected vendor option, not a palette-family synonym.
  const color = result.colors.find((c) => c.colorName === input.vendorColor);
  return color ? {
    vendorStyleId: result.styleId,
    vendorStyle: result.styleName,
    vendorColor: color.colorName,
  } : null;
}