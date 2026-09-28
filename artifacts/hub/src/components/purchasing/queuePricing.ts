import type { PoFile, VendorLookupRequest, VendorLookupResult, VendorSizeOffer } from "@workspace/api-client-react";
import { sizesMatch, type CartItem } from "../../stores/poCart";
import { canAutomaticallyApplyVendorMatch, findReusableColorMatch, findUniqueOneSizeOffer } from "./cartMatching";

// Same upper bound as the existing read-only vendor lookup service.
export const PRICE_MAX_AGE = 15 * 60 * 1000;

/** Only an explicitly saved, vendor-resolved PO for this exact invoice line
 * and unchanged product is evidence. Brand heuristics are suggestions only. */
export function savedSourceVendor(item: CartItem, files: PoFile[]): "sanmar" | "ss" | null {
  const vendors = new Set<string>();
  for (const po of files) {
    for (const line of po.lineItems) {
      if (line.printavoOrderId !== item.printavoOrderId || line.printavoLineItemId !== item.printavoLineItemId) continue;
      if (line.source !== "vendor" || line.styleNumber !== item.styleNumber ||
          line.color !== item.color || line.brand !== item.brand ||
          line.description !== item.description || !line.vendorCatalogColor) continue;
      vendors.add(po.vendorName);
    }
  }
  if (vendors.size !== 1) return null;
  const vendor = [...vendors][0];
  return vendor === "sanmar" || vendor === "ss" ? vendor : null;
}

export function pricingContext(item: CartItem): string {
  return JSON.stringify([item.printavoOrderId, item.key, item.vendor, item.styleNumber,
    item.color, item.brand, item.description, item.sizes.map(s => [s.size, s.qty])]);
}

export function lookupContext(item: CartItem): string {
  return JSON.stringify([item.vendor, item.styleNumber, item.brand, item.description]);
}

/** Assigned vendors come only from reliable saved evidence or explicit choice.
 * Remember failed attempts too: rerenders must not cause automatic retries. */
export function shouldAutoPrice(item: CartItem, attemptedContext: string | undefined): boolean {
  return (item.vendor === "sanmar" || item.vendor === "ss") &&
    item.styleNumber.trim().length > 0 && attemptedContext !== pricingContext(item);
}

/** One session-local dispatcher for automatic, manual and refresh requests.
 * Shared products use one in-flight request; at most two vendor calls run.
 * Queued requests with no remaining current consumers never reach the API. */
export function createQueueLookup(
  lookup: (request: VendorLookupRequest) => Promise<VendorLookupResult>,
) {
  const cache = new Map<string, VendorLookupResult>();
  const flights = new Map<string, {
    promise: Promise<VendorLookupResult>; consumers: (() => boolean)[];
  }>();
  const pending: (() => Promise<void>)[] = [];
  let active = 0;
  function drain() {
    while (active < 2 && pending.length) {
      const task = pending.shift()!;
      active++;
      void task().finally(() => { active--; drain(); });
    }
  }
  return (item: CartItem, refresh: boolean, current: () => boolean): Promise<VendorLookupResult> => {
    if (item.vendor !== "sanmar" && item.vendor !== "ss") {
      return Promise.reject(new Error("Choose a source vendor first."));
    }
    const key = lookupContext(item);
    const flight = flights.get(key);
    if (flight) {
      flight.consumers.push(current);
      return flight.promise;
    }
    const cached = cache.get(key);
    if (!refresh && cached && freshLookup(cached)) return Promise.resolve(cached);
    const vendor = item.vendor;
    const consumers = [current];
    let resolve!: (result: VendorLookupResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<VendorLookupResult>((yes, no) => { resolve = yes; reject = no; });
    flights.set(key, { promise, consumers });
    pending.push(async () => {
      try {
        if (!consumers.some(isCurrent => isCurrent())) throw new Error("Pricing inputs changed.");
        const result = await lookup({ vendor, style: item.styleNumber,
          brandHint: item.brand, descriptionHint: item.description });
        cache.set(key, result);
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        flights.delete(key);
      }
    });
    drain();
    return promise;
  };
}

export function isCurrentPricingRequest(
  item: CartItem, live: CartItem[], requestVersion: number, latestVersion: number | undefined,
): boolean {
  return requestVersion === latestVersion &&
    live.some(current => current.key === item.key && pricingContext(current) === pricingContext(item));
}

export function freshLookup(result: VendorLookupResult, now = Date.now()): boolean {
  const age = now - Date.parse(result.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < PRICE_MAX_AGE;
}

/** Revalidate sale dates when consuming cached offers, not just at fetch time. */
export function purchaseCost(offer: VendorSizeOffer, now = Date.now()): number | null {
  const regular = typeof offer.cost === "number" && Number.isFinite(offer.cost) && offer.cost >= 0 ? offer.cost : null;
  const date = offer.saleEndsAt?.slice(0, 10);
  const end = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T23:59:59.999Z`) : NaN;
  const validDate = Number.isFinite(end) && new Date(end).toISOString().slice(0, 10) === date;
  const sale = offer.salePrice;
  return regular !== null && typeof sale === "number" && Number.isFinite(sale) &&
    sale > 0 && sale < regular && validDate && end >= now ? sale : regular;
}

export function priceQueueItem(item: CartItem, result: VendorLookupResult, now = Date.now()): CartItem {
  if (result.vendor !== item.vendor || !freshLookup(result, now) || !result.found ||
      !canAutomaticallyApplyVendorMatch(item.brand, result.brand, result.matchType)) {
    throw new Error("No exact current vendor product match — review in PO Cart.");
  }
  const match = findReusableColorMatch(item.color, result.colors.map(c => c.colorName));
  const color = result.colors.find(c => c.colorName === match.value);
  if (!color) throw new Error("Color needs manual review in PO Cart.");
  return {
    ...item, resolved: true, vendorCatalogColor: color.colorName,
    vendorStyleId: result.styleId, vendorStyleNumber: result.styleName,
    sizes: item.sizes.map(size => {
      const matches = color.sizes.filter(s => sizesMatch(size.size, s.size));
      const offer = (matches.length === 1 ? matches[0] : null) ?? findUniqueOneSizeOffer(size.size, color.sizes);
      return { ...size, unitCost: offer ? purchaseCost(offer, now) : null,
        vendorSize: offer?.size ?? null, sku: offer?.sku ?? null,
        inventoryKey: offer?.inventoryKey ?? null, sizeIndex: offer?.sizeIndex ?? null };
    }),
  };
}

export function purchaseTotal(item: CartItem): { total: number; incomplete: boolean; pricedSizes: number } {
  let total = 0;
  let incomplete = false;
  let pricedSizes = 0;
  for (const size of item.sizes) {
    if (size.qty === 0) continue;
    if (!item.resolved || !Number.isFinite(size.qty) || size.qty < 0 ||
        size.unitCost === null || !Number.isFinite(size.unitCost) || size.unitCost < 0) {
      incomplete = true;
    } else {
      total += size.qty * size.unitCost;
      pricedSizes++;
    }
  }
  return { total, incomplete, pricedSizes };
}

export function selectedPurchaseTotals(items: CartItem[], selected: Set<string>) {
  const totals = new Map<string, ReturnType<typeof purchaseTotal>>();
  for (const item of items) {
    if (!selected.has(item.key)) continue;
    const vendor = item.vendor ?? "unassigned";
    const amount = purchaseTotal(item);
    const prior = totals.get(vendor) ?? { total: 0, incomplete: false, pricedSizes: 0 };
    totals.set(vendor, { total: prior.total + amount.total,
      incomplete: prior.incomplete || amount.incomplete, pricedSizes: prior.pricedSizes + amount.pricedSizes });
  }
  return totals;
}