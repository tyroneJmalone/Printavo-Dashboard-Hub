import {
  vendorInventory,
  vendorLookup,
  type VendorLookupResult,
} from "@workspace/api-client-react";
import { usePoCart, type CartItem } from "@/stores/poCart";
import {
  getApprovedPurchasingMapping,
  saveApprovedPurchasingMapping,
} from "./approvedMappings";

const pendingApprovals = new Map<string, ReturnType<typeof getApprovedPurchasingMapping>>();

export interface CartLookupResult extends VendorLookupResult {
  approvedColor?: string;
  mappingWarning?: string;
  mappingRejected?: boolean;
}

export function cartMappingSource(item: CartItem, vendor: "sanmar" | "ss") {
  return {
    vendor,
    sourceStyle: item.sourceStyleNumber ?? item.styleNumber,
    sourceBrand: item.brand ?? "",
    sourceColor: item.color ?? "",
  };
}

/** Approval is a candidate only: always validate against fresh live vendor offers. */
export async function lookupCartLine(
  item: CartItem,
  data: Parameters<typeof vendorLookup>[0],
): Promise<CartLookupResult> {
  let approved: Awaited<ReturnType<typeof getApprovedPurchasingMapping>> = null;
  let mappingWarning: string | undefined;
  try {
    const source = cartMappingSource(item, data.vendor);
    const signature = JSON.stringify(source);
    let request = pendingApprovals.get(signature);
    if (!request) {
      request = getApprovedPurchasingMapping(source)
        .finally(() => pendingApprovals.delete(signature));
      pendingApprovals.set(signature, request);
    }
    approved = await request;
  } catch (err) {
    mappingWarning = `Could not load approved match: ${err instanceof Error ? err.message : "service unavailable"}`;
  }
  // An explicit style correction in this cart takes priority over a saved rule.
  const candidate = approved && data.style === (item.sourceStyleNumber ?? item.styleNumber)
    ? approved : null;
  const res = await lookupCartVendor({
    ...data,
    style: candidate ? candidate.vendorStyle : data.style,
  });
  if (!candidate) return { ...res, mappingWarning };
  const valid = res.found && res.styleName === candidate.vendorStyle &&
    res.styleId === candidate.vendorStyleId &&
    res.colors.some((c) => c.colorName === candidate.vendorColor);
  return {
    ...res,
    approvedColor: valid ? candidate.vendorColor : undefined,
    mappingRejected: !valid,
    mappingWarning: valid ? undefined : "Approved match no longer matches the live vendor product/color — review manually.",
  };
}

/** Call only from the explicit approval button, never from pricing/auto-match. */
export async function approveCartSelection(item: CartItem, res: VendorLookupResult) {
  if ((item.vendor !== "sanmar" && item.vendor !== "ss") ||
      res.vendor !== item.vendor || !res.found || !res.styleName ||
      item.vendorStyleId !== res.styleId || item.vendorStyleNumber !== res.styleName ||
      !item.vendorCatalogColor ||
      !res.colors.some((c) => c.colorName === item.vendorCatalogColor)) {
    throw new Error("Select a current vendor product and color before approving.");
  }
  return saveApprovedPurchasingMapping({
    ...cartMappingSource(item, item.vendor),
    vendorStyleId: res.styleId,
    vendorStyle: res.styleName,
    vendorColor: item.vendorCatalogColor,
  });
}

const inventoryRequestVersions = new Map<string, number>();
const lookupVersions = new Map<string, number>();
const pendingLookups = new Map<string, ReturnType<typeof vendorLookup>>();
const pendingInventory = new Map<string, ReturnType<typeof vendorInventory>>();

/** Coalesce overlapping identical reads only; never cache a failed/live stock read. */
export function lookupCartVendor(data: Parameters<typeof vendorLookup>[0]) {
  const signature = JSON.stringify(data);
  let request = pendingLookups.get(signature);
  if (!request) {
    request = vendorLookup(data).finally(() => pendingLookups.delete(signature));
    pendingLookups.set(signature, request);
  }
  return request;
}

/** Read synchronously after setVendorAll, not the previous React render. */
export function cartItemsNeedingPricing(results: Record<string, VendorLookupResult>) {
  return usePoCart.getState().items.filter((i) =>
    (i.vendor === "sanmar" || i.vendor === "ss") &&
    !(i.resolved && i.sizes.every((s) => s.qty <= 0 || s.unitCost !== null) &&
      i.inventory !== null && results[i.key]),
  );
}

/** Shared by single and bulk lookups; edits/removal/newer requests invalidate it. */
export function beginCartLookup(key: string): () => boolean {
  const snapshot = usePoCart.getState().items.find((i) => i.key === key);
  const version = (lookupVersions.get(key) ?? 0) + 1;
  lookupVersions.set(key, version);
  return () => lookupVersions.get(key) === version &&
    usePoCart.getState().items.find((i) => i.key === key) === snapshot;
}

/**
 * Shared cart actions used by BOTH the per-item card flow and the cart-wide
 * "Get pricing" bulk flow — keeps color-apply and stock-check behavior
 * identical so the two paths can never drift apart.
 */

/**
 * Apply a looked-up vendor color's pricing to a cart line (auto size-matching
 * happens in the store). Returns false when the color isn't in the result.
 */
export function applyLookupColor(
  key: string,
  res: VendorLookupResult,
  colorName: string,
): boolean {
  const color = res.colors.find((c) => c.colorName === colorName);
  if (!color) return false;
  usePoCart.getState().applyVendorData(key, {
    vendorCatalogColor: color.colorName,
    vendorStyleId: res.styleId,
    vendorStyleNumber: res.styleName,
    sizes: color.sizes.map((s) => ({
      size: s.size,
      unitCost: s.salePrice ?? s.cost,
      sku: s.sku,
      inventoryKey: s.inventoryKey,
      sizeIndex: s.sizeIndex,
    })),
  });
  return true;
}

/**
 * Check warehouse stock for the vendor size labels the line actually matched
 * (SanMar rejects Printavo labels). Reads live cart state so it works after
 * both the initial color match AND a manual per-size remap of a combined size.
 * Silently ignores stale responses (user changed color mid-flight).
 * Throws on API failure — callers decide how loudly to surface that.
 */
export async function fetchMatchedInventory(
  key: string,
  vendor: "sanmar" | "ss",
  res: VendorLookupResult,
  colorName: string,
): Promise<void> {
  const requestVersion = (inventoryRequestVersions.get(key) ?? 0) + 1;
  inventoryRequestVersions.set(key, requestVersion);
  const current = usePoCart.getState().items.find((i) => i.key === key);
  if (!current || current.vendor !== vendor ||
      current.vendorCatalogColor !== colorName ||
      current.vendorStyleId !== res.styleId) return;
  const vendorSizes = [
    ...new Set(
      current.sizes.map((s) => s.vendorSize).filter((v): v is string => v !== null),
    ),
  ].slice(0, 20);
  if (vendorSizes.length === 0) {
    throw new Error("Map a vendor size before checking warehouse stock.");
  }
  const requestSignature = JSON.stringify({
    vendor,
    style: res.styleName ?? res.styleQueried,
    styleId: res.styleId,
    colorName,
    vendorSizes,
  });
  let request = pendingInventory.get(requestSignature);
  if (!request) {
    request = vendorInventory({
      vendor,
      style: res.styleName ?? res.styleQueried,
      // Pin stock to the SAME product the lookup priced — a re-search by style
      // number alone can hit another brand's identical number.
      styleId: res.styleId,
      catalogColor: colorName,
      sizes: vendorSizes,
    }).finally(() => pendingInventory.delete(requestSignature));
    pendingInventory.set(requestSignature, request);
  }
  const inv = await request;
  // Ignore stale responses after any newer request, color/product change, or
  // manual size remap. A color-only check is insufficient when two remaps race.
  const cur = usePoCart.getState().items.find((i) => i.key === key);
  const liveVendorSizes = cur
    ? [
        ...new Set(
          cur.sizes.map((s) => s.vendorSize).filter((v): v is string => v !== null),
        ),
      ].slice(0, 20)
    : [];
  const liveSignature = cur
    ? JSON.stringify({
        vendor: cur.vendor,
        style: cur.vendorStyleNumber ?? res.styleName ?? res.styleQueried,
        styleId: cur.vendorStyleId,
        colorName: cur.vendorCatalogColor,
        vendorSizes: liveVendorSizes,
      })
    : null;
  if (
    !cur ||
    cur.sizes !== current.sizes ||
    inventoryRequestVersions.get(key) !== requestVersion ||
    liveSignature !== requestSignature ||
    cur.vendorCatalogColor !== inv.catalogColor
  ) return;
  usePoCart.getState().applyInventory(
    key,
    inv.sizes.map((s) => ({
      size: s.size,
      found: s.found,
      warehouses: s.warehouses,
    })),
  );
}
