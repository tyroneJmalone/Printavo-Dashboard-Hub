import {
  vendorInventory,
  type VendorLookupResult,
} from "@workspace/api-client-react";
import { usePoCart } from "@/stores/poCart";

const inventoryRequestVersions = new Map<string, number>();

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
  if (!current) return;
  const vendorSizes = [
    ...new Set(
      current.sizes.map((s) => s.vendorSize).filter((v): v is string => v !== null),
    ),
  ].slice(0, 20);
  if (vendorSizes.length === 0) return;
  const requestSignature = JSON.stringify({
    vendor,
    style: res.styleQueried,
    styleId: res.styleId,
    colorName,
    vendorSizes,
  });
  const inv = await vendorInventory({
    vendor,
    style: res.styleQueried,
    // Pin stock to the SAME product the lookup priced — a re-search by style
    // number alone can hit another brand's identical number.
    styleId: res.styleId,
    catalogColor: colorName,
    sizes: vendorSizes,
  });
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
        style: res.styleQueried,
        styleId: cur.vendorStyleId,
        colorName: cur.vendorCatalogColor,
        vendorSizes: liveVendorSizes,
      })
    : null;
  if (
    !cur ||
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
