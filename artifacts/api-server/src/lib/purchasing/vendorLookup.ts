import { SanMarClient, type SanMarProductEntry } from "@workspace/sanmar";
import { SSClient, type SSProduct } from "@workspace/ss-activewear";

/**
 * Unified live vendor catalog lookup (SanMar SOAP / S&S REST).
 * Cost semantics (verified against the live authenticated APIs + Tyler):
 *  - SanMar: casePrice = the regular dealer NET cost (THE cost — what the
 *    shop actually pays; PC54 Jet Black case $3.00 vs piece $4.00, and Tyler
 *    confirmed $3 is right). piecePrice is the higher broken-case tier —
 *    never the baseline. caseSalePrice is promotional, present ONLY during
 *    a dated sale; genuine only when >0, < regular, and saleEndDate present.
 *    (The original Breezy app likewise used the Pricing service's casePrice.)
 *  - S&S: piecePrice = regular dealer cost; salePrice genuine only if
 *    >0, < piecePrice, and saleExpiration present (customerPrice mirrors
 *    salePrice during sales — never a baseline).
 * Search accepts a bare style number ("PC54") or brand/keywords + number
 * ("port company pc54", "bella 3001") — tokens containing a digit are tried
 * as style numbers; the remaining words disambiguate brand (Gildan 5000 vs
 * Bayside 5000) and decide exact-vs-closest.
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
  /** Small color swatch image (absolute URL) — null when the vendor has none. */
  swatchImage: string | null;
  /** Product photo in this color (absolute URL) — null when the vendor has none. */
  productImage: string | null;
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
  /** Style-level hero image (absolute URL) — fallback before a color is chosen. */
  styleImage: string | null;
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

/** S&S image fields are RELATIVE paths (e.g. "Images/Color/..._fm.jpg"). */
const SS_IMAGE_BASE = "https://www.ssactivewear.com/";
function ssImageUrl(path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return SS_IMAGE_BASE + path.replace(/^\/+/, "");
}

function sanMarToColors(entries: SanMarProductEntry[]): VendorColorOffer[] {
  const byColor = new Map<
    string,
    { sizes: VendorSizeOffer[]; swatchImage: string | null; productImage: string | null }
  >();
  for (const e of entries) {
    let bucket = byColor.get(e.catalogColor);
    if (!bucket) {
      bucket = { sizes: [], swatchImage: null, productImage: null };
      byColor.set(e.catalogColor, bucket);
    }
    const sizes = bucket.sizes;
    bucket.swatchImage ??= e.colorSwatchImage;
    bucket.productImage ??= e.colorProductImage;
    // casePrice is the shop's regular dealer net (Tyler-confirmed: PC54 = $3.00);
    // piecePrice is the higher broken-case tier ($4.00) — only a fallback when
    // casePrice is missing. Sale prices follow the same case-first preference
    // and only count when genuinely lower inside a dated sale window.
    const regular = e.casePrice ?? e.piecePrice;
    const salePrice = e.casePrice !== null ? e.caseSalePrice : e.pieceSalePrice;
    const genuineSale =
      salePrice !== null &&
      salePrice > 0 &&
      regular !== null &&
      salePrice < regular &&
      e.saleEndDate !== null;
    sizes.push({
      size: e.size.toUpperCase(),
      sku: null,
      inventoryKey: e.inventoryKey,
      sizeIndex: e.sizeIndex,
      cost: regular,
      msrp: null,
      salePrice: genuineSale ? salePrice : null,
      saleEndsAt: genuineSale ? e.saleEndDate : null,
      inventoryTotal: null,
      warehouses: null,
    });
  }
  return Array.from(byColor.entries())
    .map(([colorName, bucket]) => ({
      colorName,
      swatchImage: bucket.swatchImage,
      productImage: bucket.productImage,
      sizes: bucket.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)),
    }))
    .sort((a, b) => a.colorName.localeCompare(b.colorName));
}

function ssToColors(products: SSProduct[]): VendorColorOffer[] {
  const byColor = new Map<
    string,
    { sizes: VendorSizeOffer[]; swatchImage: string | null; productImage: string | null }
  >();
  for (const p of products) {
    let bucket = byColor.get(p.colorName);
    if (!bucket) {
      bucket = { sizes: [], swatchImage: null, productImage: null };
      byColor.set(p.colorName, bucket);
    }
    const sizes = bucket.sizes;
    bucket.swatchImage ??= ssImageUrl(p.colorSwatchImage);
    bucket.productImage ??= ssImageUrl(p.colorFrontImage);
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
    .map(([colorName, bucket]) => ({
      colorName,
      swatchImage: bucket.swatchImage,
      productImage: bucket.productImage,
      sizes: bucket.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)),
    }))
    .sort((a, b) => a.colorName.localeCompare(b.colorName));
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
 * Split a search query into style-number candidates (tokens containing a
 * digit, e.g. "pc54", "3001", "5000") and plain words (brand/description,
 * e.g. "port", "company", "bella"). Lets "port company pc54" find PC54.
 */
function parseQuery(query: string): { styleTokens: string[]; textTokens: string[] } {
  const tokens = normText(query).split(" ").filter(Boolean);
  return {
    styleTokens: tokens.filter((t) => /\d/.test(t)),
    textTokens: tokens.filter((t) => !/\d/.test(t)),
  };
}

/** Do all plain query words appear in the matched product's brand+title?
 *  Whole-word matches only — a loose substring test would let "co" match
 *  "cotton" and wrongly suppress the closest-match double-check cue. */
function textTokensMatch(textTokens: string[], brand: string | null, title: string | null): boolean {
  if (textTokens.length === 0) return true;
  const hay = ` ${normText(`${brand ?? ""} ${title ?? ""}`)} `;
  return textTokens.every((t) => hay.includes(` ${t} `));
}

const MAX_STYLE_TOKEN_TRIES = 3;

async function lookupSanMar(query: string): Promise<VendorLookupResult> {
  const client = getSanMarClient();
  const { styleTokens, textTokens } = parseQuery(query);
  // Direct lookup first — the common case is a bare style number. If SanMar
  // doesn't recognize the whole query, retry each digit-bearing token
  // ("port company pc54" → "PC54"). SOAP is slow, so cap the retries.
  let entries = await client.getProductInfo(query);
  let viaFullQuery = entries.length > 0;
  if (entries.length === 0) {
    for (const t of styleTokens.slice(0, MAX_STYLE_TOKEN_TRIES)) {
      if (normText(t) === normText(query)) continue; // same as the direct try
      entries = await client.getProductInfo(t.toUpperCase());
      if (entries.length > 0) break;
    }
  }
  const first = entries[0];
  const colors = sanMarToColors(entries);
  // Token-based match counts as exact only when the remaining words agree
  // with what SanMar returned ("port company pc54" → Port & Company PC54);
  // otherwise flag it so the user double-checks ("gildan pc54" → closest).
  const exact =
    entries.length > 0 &&
    (viaFullQuery ||
      textTokensMatch(textTokens, first?.brandName ?? null, first?.productTitle ?? null));
  return {
    found: entries.length > 0,
    matchType: entries.length === 0 ? "none" : exact ? "exact" : "closest",
    vendor: "sanmar",
    styleQueried: query,
    styleId: null,
    styleName: first?.style ?? null,
    brand: first?.brandName ?? null,
    title: first?.productTitle ?? null,
    // SanMar has no style-level hero image in this service — first color's photo.
    styleImage: colors.find((c) => c.productImage)?.productImage ?? null,
    colors,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
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
  styleTokens: string[],
  textTokens: string[],
): number {
  let score = 0;
  if (candidate.styleName.toLowerCase() === style.toLowerCase()) {
    score += 100;
  } else if (styleTokens.includes(normText(candidate.styleName))) {
    // "bella 3001" — the digit token IS the style number.
    score += 90;
  }
  const brand = normText(candidate.brandName);
  const brandHint = normText(hints.brandHint ?? "");
  const descHint = normText(hints.descriptionHint ?? "");
  if (brand) {
    // Brand words typed directly in the query dominate ("gildan 5000" must
    // beat Bayside 5000 even though S&S's own relevance puts Bayside first).
    const brandWords = brand.split(" ").filter(Boolean);
    const typedOverlap = brandWords.filter((w) => textTokens.includes(w)).length;
    if (typedOverlap > 0) score += 50 + typedOverlap;
    if (brandHint && (brandHint.includes(brand) || brand.includes(brandHint))) {
      score += 50;
    } else if (descHint && descHint.includes(brand)) {
      score += 30;
    }
  }
  if (candidate.title) {
    const titleWords = normText(candidate.title).split(" ");
    if (textTokens.length > 0) {
      const typed = new Set(textTokens.filter((t) => t.length >= 3));
      score += Math.min(titleWords.filter((w) => typed.has(w)).length, 10);
    }
    if (descHint) {
      const descTokens = new Set(descHint.split(" ").filter((t) => t.length >= 3));
      score += Math.min(
        titleWords.filter((w) => w.length >= 3 && descTokens.has(w)).length,
        10,
      );
    }
  }
  return score;
}

async function lookupSS(
  style: string,
  hints: VendorLookupHints,
): Promise<VendorLookupResult> {
  const client = getSSClient();
  const { styleTokens, textTokens } = parseQuery(style);
  // S&S's search handles free text reasonably well, but if the combined
  // query returns nothing ("port company pc54"-style input), retry with
  // just the digit-bearing tokens — those are the style-number candidates.
  let styles = await client.searchStyles(style);
  if (styles.length === 0) {
    for (const t of styleTokens.slice(0, MAX_STYLE_TOKEN_TRIES)) {
      if (normText(t) === normText(style)) continue;
      styles = await client.searchStyles(t);
      if (styles.length > 0) break;
    }
  }
  let chosen: (typeof styles)[number] | undefined;
  let best = -1;
  for (const s of styles) {
    const score = scoreSSCandidate(s, style, hints, styleTokens, textTokens);
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
      styleImage: null,
      colors: [],
      cached: false,
      fetchedAt: new Date().toISOString(),
    };
  }
  // Exact when the whole query is the style number, or when the digit token
  // matches the style number AND the remaining words agree with the brand/
  // title ("bella 3001" → BELLA + CANVAS 3001 = exact; bare "5000" landing
  // on Bayside when Gildan also makes a 5000 stays "closest"-worthy only if
  // the user typed words that don't match).
  const exact =
    chosen.styleName.toLowerCase() === style.toLowerCase() ||
    (styleTokens.includes(normText(chosen.styleName)) &&
      textTokensMatch(textTokens, chosen.brandName, chosen.title));
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
    styleImage: ssImageUrl(chosen.styleImage),
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
