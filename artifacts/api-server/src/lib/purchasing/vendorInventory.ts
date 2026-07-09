import { SanMarClient, SANMAR_WAREHOUSES } from "@workspace/sanmar";
import {
  vendorLookup,
  ssColorsByStyleId,
  VendorConfigError,
  type VendorId,
} from "./vendorLookup";

/**
 * Per-warehouse availability for an exact vendor catalog color.
 * Called AFTER the cart resolves a color via vendor-lookup, so
 * catalogColor is always the vendor's exact spelling (SanMar errors on
 * anything else — "Jet Black", never "Black").
 *
 * - SanMar: one SOAP inventory call per size (~200-600ms each);
 *   quantities align with SANMAR_WAREHOUSES order and are capped at
 *   3000 per warehouse (capped=true → display "3000+").
 * - S&S: served from the vendor-lookup result (its product feed already
 *   carries per-warehouse quantities).
 */

export interface WarehouseAvailability {
  code: string;
  name: string;
  qty: number;
  capped: boolean;
}

export interface InventorySizeResult {
  size: string;
  /** False when the vendor doesn't carry this size in this color. */
  found: boolean;
  warehouses: WarehouseAvailability[];
}

export interface VendorInventoryResult {
  vendor: VendorId;
  style: string;
  catalogColor: string;
  sizes: InventorySizeResult[];
  cached: boolean;
  fetchedAt: string;
}

const SANMAR_QTY_CAP = 3000;
/** Inventory moves faster than pricing — cache for 5 minutes only. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; result: VendorInventoryResult }>();

function getSanMarClient(): SanMarClient {
  const customerNumber = process.env.SANMAR_ACCOUNT_NUMBER;
  const username = process.env.SANMAR_USERNAME;
  const password = process.env.SANMAR_PASSWORD;
  if (!customerNumber || !username || !password) {
    throw new VendorConfigError("SanMar credentials are not configured");
  }
  return new SanMarClient({ customerNumber, username, password });
}

async function sanMarInventory(
  style: string,
  catalogColor: string,
  sizes: string[],
): Promise<InventorySizeResult[]> {
  const client = getSanMarClient();
  const out: InventorySizeResult[] = [];
  // Sequential on purpose — SanMar's SOAP service dislikes bursts.
  for (const size of sizes) {
    try {
      const inv = await client.getInventory(style, catalogColor, size);
      out.push({
        size,
        found: inv.quantities.length > 0,
        warehouses: inv.quantities.map((qty, i) => {
          const wh = SANMAR_WAREHOUSES[i];
          return {
            code: wh ? String(wh.whseNo) : `?${i}`,
            name: wh ? wh.name : `Warehouse ${i + 1}`,
            qty,
            capped: qty >= SANMAR_QTY_CAP,
          };
        }),
      });
    } catch (err) {
      // "Invalid product specified" = size not carried in this color.
      if (err instanceof Error && /invalid product/i.test(err.message)) {
        out.push({ size, found: false, warehouses: [] });
        continue;
      }
      throw err;
    }
  }
  return out;
}

async function ssInventory(
  style: string,
  catalogColor: string,
  sizes: string[],
  styleId: string | null,
): Promise<InventorySizeResult[]> {
  // Prefer the exact styleID from the lookup that priced this line —
  // re-searching by style number can land on a DIFFERENT brand that
  // shares the number (e.g. Bayside 5000 vs Gildan 5000).
  const colors =
    styleId && /^\d+$/.test(styleId)
      ? await ssColorsByStyleId(Number(styleId))
      : (await vendorLookup("ss", style)).colors;
  const color = colors.find(
    (c) => c.colorName.trim().toLowerCase() === catalogColor.trim().toLowerCase(),
  );
  return sizes.map((size) => {
    const offer = color?.sizes.find(
      (s) => s.size.trim().toUpperCase() === size.trim().toUpperCase(),
    );
    if (!offer) return { size, found: false, warehouses: [] };
    return {
      size,
      found: true,
      warehouses: (offer.warehouses ?? []).map((w) => ({
        code: w.code,
        name: w.code,
        qty: w.qty,
        capped: false,
      })),
    };
  });
}

export async function vendorInventory(
  vendor: VendorId,
  style: string,
  catalogColor: string,
  sizes: string[],
  styleId: string | null = null,
): Promise<VendorInventoryResult> {
  const cleanStyle = style.trim();
  const cleanColor = catalogColor.trim();
  const cleanSizes = [...new Set(sizes.map((s) => s.trim()).filter(Boolean))];
  const key = `${vendor}:${cleanStyle.toUpperCase()}:${styleId ?? ""}:${cleanColor.toUpperCase()}:${cleanSizes
    .map((s) => s.toUpperCase())
    .sort()
    .join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.result, cached: true };
  }
  const sizeResults =
    vendor === "sanmar"
      ? await sanMarInventory(cleanStyle, cleanColor, cleanSizes)
      : await ssInventory(cleanStyle, cleanColor, cleanSizes, styleId);
  const result: VendorInventoryResult = {
    vendor,
    style: cleanStyle,
    catalogColor: cleanColor,
    sizes: sizeResults,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), result });
  return result;
}
