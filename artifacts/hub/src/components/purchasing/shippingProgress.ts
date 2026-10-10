import type { VendorShippingTerms } from "@workspace/api-client-react";
import type { CartItem } from "@/stores/poCart";
import { purchaseTotal } from "./queuePricing";

const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export type ShippingPricedItem = CartItem & { shippingVendorBrand?: string | null };

/** Queue selections are a proposed single purchase, not submitted POs or warehouse allocations. */
export function shippingProgress(items: ShippingPricedItem[], selected: Set<string>, vendor: string,
  terms: VendorShippingTerms | null, now = Date.now()) {
  let cents = 0, excludedLines = 0, incomplete = false;
  if (!terms) return null;
  const brands = new Set(terms.excludedBrands.map(normalize));
  const styles = new Set(terms.excludedStyles.map(normalize));
  for (const item of items) {
    if (!selected.has(item.key) || item.vendor !== vendor) continue;
    if (brands.has(normalize(item.shippingVendorBrand ?? "")) ||
        styles.has(normalize(item.styleNumber)) ||
        styles.has(normalize(item.vendorStyleNumber ?? ""))) {
      excludedLines++;
      continue;
    }
    // Missing identity cannot prove a line is outside the configured exclusions.
    if ((brands.size && !item.shippingVendorBrand?.trim()) ||
        (styles.size && !item.vendorStyleNumber?.trim())) {
      incomplete = true;
      continue;
    }
    const total = purchaseTotal(item);
    cents += Math.round(total.total * 100);
    incomplete ||= total.incomplete;
  }
  const threshold = Math.round(terms.threshold * 100);
  const expired = terms.validThrough < new Date(now).toISOString().slice(0, 10);
  const blockers = [
    ...(expired ? ["Account terms need re-verification."] : []),
    ...(incomplete ? ["Incomplete pricing or exclusion identity; unresolved amounts excluded."] : []),
    ...(terms.scope === "warehouse" ? ["Per-warehouse threshold: allocations are not known in this queue; combined spend cannot establish eligibility."] : []),
    ...(terms.shippingMethod.trim() ? [`Shipping method must be ${terms.shippingMethod}; the actual method is not verified here.`] : []),
    ...(terms.otherConditions.trim() ? [`Other conditions require review: ${terms.otherConditions}`] : []),
  ];
  return { amount: cents / 100, remaining: Math.max(0, threshold - cents) / 100,
    percent: threshold === 0 ? 100 : Math.min(100, cents / threshold * 100),
    excludedLines, incomplete, expired, blockers,
    estimatedEligible: cents >= threshold && blockers.length === 0 };
}
