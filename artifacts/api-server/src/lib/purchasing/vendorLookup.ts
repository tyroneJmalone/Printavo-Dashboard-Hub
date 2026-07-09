import { SanMarClient, type SanMarProductEntry } from "@workspace/sanmar";
import { SSClient, type SSProduct } from "@workspace/ss-activewear";

/**
 * Unified live vendor catalog lookup (SanMar SOAP / S&S REST).
 * Cost semantics (proven in legacy apps — do not change):
 *  - SanMar: pieceSalePrice = account net cost (THE cost), piecePrice = MSRP.
 *  - S&S: piecePrice = regular dealer cost; salePrice genuine only if
 *    >0, < piecePrice, and saleExpiration present (customerPrice mirrors
 *    salePrice during sales — never a baseline).
 */

export type VendorId = "sanmar" | "ss";

export interface VendorWarehouseQty {
  code: string;
  qty: number;
}

export interface VendorSizeOffer {
  size: string;
  sku: string | null;
  inventoryKey: string | null;
  sizeIndex: number | null;
  cost: number | null;
  msrp: number | null;
  salePrice: number | null;
  saleEndsAt: string | null;
  inventoryTotal: number | null;
  warehouses: VendorWarehouseQty[] | null;
}

export interface VendorColorOffer {
  colorName: string;
  sizes: VendorSizeOffer[];
}

export interface VendorLookupResult {
  found: boolean;
  matchType: "exact" | "closest" | "none";
  vendor: VendorId;
  styleQueried: string;
  /** Vendor-internal id of the matched product (S&S styleID); null for SanMar. */
  styleId: string | null;
  styleName: string | null;
  brand: string | null;
  title: string | null;
  colors: VendorColorOffer[];
  cached: boolean;
  fetchedAt: string;
}

export interface VendorLookupHints {
  brandHint?: string | null;
  descriptionHint?: string | null;
}

export class VendorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorConfigError";
  }
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; result: VendorLookupResult }>();

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"];
function sizeRank(size: string): number {
  const i = SIZE_ORDER.indexOf(size.toUpperCase());
  return i === -1 ? 100 : i;
}

function getSanMarClient(): SanMarClient {
  const customerNumber = process.env.SANMAR_ACCOUNT_NUMBER;
  const username = process.env.SANMAR_USERNAME;
  const password = process.env.SANMAR_PASSWORD;
  if (!customerNumber || !username || !password) {
    throw new VendorConfigError("SanMar credentials are not configured");
  }
  return new SanMarClient({ customerNumber, username, password });
}

function getSSClient(): SSClient {
  const accountNumber = process.env.SS_ACCOUNT_NUMBER;
  const apiKey = process.env.SS_API_KEY;
  if (!accountNumber || !apiKey) {
    throw new VendorConfigError("S&S Activewear credentials are not configured");
  }
  return new SSClient({ accountNumber, apiKey });
}

function sanMarToColors(entries: SanMarProductEntry[]): VendorColorOffer[] {
  const byColor = new Map<string, VendorSizeOffer[]>();
  for (const e of entries) {
    let sizes = byColor.get(e.catalogColor);
    if (!sizes) {
      sizes = [];
      byColor.set(e.catalogColor, sizes);
    }
    sizes.push({
      size: e.size.toUpperCase(),
      sku: null,
      inventoryKey: e.inventoryKey,
      sizeIndex: e.sizeIndex,
      // pieceSalePrice IS the account net cost. Never fall back to
      // piecePrice (MSRP) — a null cost must surface in the UI instead
      // of silently inflating the PO.
      cost: e.pieceSalePrice,
      msrp: e.piecePrice,
      salePrice: null,
      saleEndsAt: null,
      inventoryTotal: null,
      warehouses: null,
    });
  }
  return Array.from(byColor.entries())
    .map(([colorName, sizes]) => ({
      colorName,
      sizes: sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)),
    }))
    .sort((a, b) => a.colorName.localeCompare(b.colorName));
}

function ssToColors(products: SSProduct[]): VendorColorOffer[] {
  const byColor = new Map<string, VendorSizeOffer[]>();
  for (const p of products) {
    let sizes = byColor.get(p.colorName);
    if (!sizes) {
      sizes = [];
      byColor.set(p.colorName, sizes);
    }
    const genuineSale =
      p.salePrice !== null &&
      p.salePrice > 0 &&
      p.piecePrice !== null &&
      p.salePrice < p.piecePrice &&
      p.saleExpiration !== null;
    sizes.push({
      size: p.sizeName.toUpperCase(),
      sku: p.sku,
      inventoryKey: null,
      sizeIndex: null,
      cost: p.piecePrice,
      msrp: null,
      salePrice: genuineSale ? p.salePrice : null,
      saleEndsAt: genuineSale ? p.saleExpiration : null,
      inventoryTotal: p.qty,
      warehouses: p.warehouses.map((w) => ({ code: w.warehouseAbbr, qty: w.qty })),
    });
  }
  return Array.from(byColor.entries())
    .map(([colorName, sizes]) => ({
      colorName,
      sizes: sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)),
    }))
    .sort((a, b) => a.colorName.localeCompare(b.colorName));
}

async function lookupSanMar(style: string): Promise<VendorLookupResult> {
  const entries = await getSanMarClient().getProductInfo(style);
  const first = entries[0];
  return {
    found: entries.length > 0,
    matchType: entries.length > 0 ? "exact" : "none",
    vendor: "sanmar",
    styleQueried: style,
    styleId: null,
    styleName: first?.style ?? null,
    brand: first?.brandName ?? null,
    title: first?.productTitle ?? null,
    colors: sanMarToColors(entries),
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

/** Lowercase, alphanumeric-only tokens — brand/title strings across
 *  Printavo and vendors disagree on punctuation ("Independent Trading Co."). */
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Score an S&S search candidate against the queried style + Printavo hints.
 * Multiple brands share manufacturer style numbers (S&S carries BOTH
 * Bayside 5000 and Gildan 5000 — search returns Bayside first), so an
 * exact style-number match alone is not enough; the brand hint dominates
 * among exact matches.
 */
function scoreSSCandidate(
  candidate: { styleName: string; brandName: string; title: string | null },
  style: string,
  hints: VendorLookupHints,
): number {
  let score = 0;
  if (candidate.styleName.toLowerCase() === style.toLowerCase()) score += 100;
  const brand = normText(candidate.brandName);
  const brandHint = normText(hints.brandHint ?? "");
  const descHint = normText(hints.descriptionHint ?? "");
  if (brand) {
    if (brandHint && (brandHint.includes(brand) || brand.includes(brandHint))) {
      score += 50;
    } else if (descHint && descHint.includes(brand)) {
      score += 30;
    }
  }
  if (descHint && candidate.title) {
    const descTokens = new Set(descHint.split(" ").filter((t) => t.length >= 3));
    const overlap = normText(candidate.title)
      .split(" ")
      .filter((t) => t.length >= 3 && descTokens.has(t)).length;
    score += Math.min(overlap, 10);
  }
  return score;
}

async function lookupSS(
  style: string,
  hints: VendorLookupHints,
): Promise<VendorLookupResult> {
  const client = getSSClient();
  const styles = await client.searchStyles(style);
  let chosen: (typeof styles)[number] | undefined;
  let best = -1;
  for (const s of styles) {
    const score = scoreSSCandidate(s, style, hints);
    // Strict > keeps the first result on ties (S&S's own relevance order).
    if (score > best) {
      best = score;
      chosen = s;
    }
  }
  if (!chosen) {
    return {
      found: false,
      matchType: "none",
      vendor: "ss",
      styleQueried: style,
      styleId: null,
      styleName: null,
      brand: null,
      title: null,
      colors: [],
      cached: false,
      fetchedAt: new Date().toISOString(),
    };
  }
  const exact = chosen.styleName.toLowerCase() === style.toLowerCase();
  const products = await client.getProducts(chosen.styleID);
  return {
    found: products.length > 0,
    matchType: products.length === 0 ? "none" : exact ? "exact" : "closest",
    vendor: "ss",
    styleQueried: style,
    styleId: String(chosen.styleID),
    styleName: chosen.styleName,
    brand: chosen.brandName,
    title: chosen.title,
    colors: ssToColors(products),
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Per-warehouse color/size offers for an exact S&S styleID — used by
 * vendor-inventory so stock always comes from the SAME product the lookup
 * priced, never a re-search that could land on a different brand.
 */
const ssStyleIdCache = new Map<number, { at: number; colors: VendorColorOffer[] }>();
const SS_STYLE_ID_TTL_MS = 5 * 60 * 1000;

export async function ssColorsByStyleId(styleID: number): Promise<VendorColorOffer[]> {
  const hit = ssStyleIdCache.get(styleID);
  if (hit && Date.now() - hit.at < SS_STYLE_ID_TTL_MS) return hit.colors;
  const products = await getSSClient().getProducts(styleID);
  const colors = ssToColors(products);
  ssStyleIdCache.set(styleID, { at: Date.now(), colors });
  return colors;
}

export async function vendorLookup(
  vendor: VendorId,
  style: string,
  hints: VendorLookupHints = {},
): Promise<VendorLookupResult> {
  const hintKey =
    vendor === "ss"
      ? `:${normText(hints.brandHint ?? "")}:${normText(hints.descriptionHint ?? "")}`
      : "";
  const key = `${vendor}:${style.trim().toUpperCase()}${hintKey}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.result, cached: true };
  }
  const result =
    vendor === "sanmar"
      ? await lookupSanMar(style.trim())
      : await lookupSS(style.trim(), hints);
  cache.set(key, { at: Date.now(), result });
  return result;
}
