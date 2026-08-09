import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  vendorLookup,
  type VendorId,
  type VendorLookupResult,
} from "./vendorLookup";

/**
 * Product Finder — cross-vendor style search + invoice stock-check support.
 * Fans one query out to BOTH vendors' live lookup layers at once, and knows
 * that the same garment often lives under different style numbers per vendor
 * (Gildan's marketing number "G500" vs the manufacturer number "5000").
 *
 * Alias groups are equivalence sets: when the typed query misses at a vendor,
 * every other member of its group is retried before giving up. Seeded with
 * the common Gildan marketing↔manufacturer pairs; extendable (phase 2 moves
 * this into the local catalog).
 */

interface AliasGroup {
  styles: readonly string[];
  /** Brand the group belongs to — disambiguates shared manufacturer numbers
   *  (S&S carries BOTH Bayside 5000 and Gildan 5000; G500 means Gildan). */
  brand: string;
}

const STYLE_ALIAS_GROUPS: ReadonlyArray<AliasGroup> = [
  // Gildan marketing number ↔ manufacturer number (both vendors accept the
  // manufacturer number; customers frequently say the G-number).
  { styles: ["g500", "5000"], brand: "Gildan" },
  { styles: ["g500l", "5000l"], brand: "Gildan" },
  { styles: ["g500b", "5000b"], brand: "Gildan" },
  { styles: ["g200", "2000"], brand: "Gildan" },
  { styles: ["g200l", "2000l"], brand: "Gildan" },
  { styles: ["g240", "2400"], brand: "Gildan" },
  { styles: ["g185", "18500"], brand: "Gildan" },
  { styles: ["g185b", "18500b"], brand: "Gildan" },
  { styles: ["g180", "18000"], brand: "Gildan" },
  { styles: ["g180b", "18000b"], brand: "Gildan" },
  { styles: ["g800", "8000"], brand: "Gildan" },
  { styles: ["g640", "64000"], brand: "Gildan" },
  { styles: ["g424", "42400"], brand: "Gildan" },
  { styles: ["g420", "42000"], brand: "Gildan" },
  { styles: ["g460", "46000"], brand: "Gildan" },
];

function normStyle(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Other members of the query's alias group, with the group's brand (empty when unknown). */
export function styleAliases(query: string): { style: string; brand: string }[] {
  const n = normStyle(query);
  if (!n) return [];
  for (const group of STYLE_ALIAS_GROUPS) {
    if (group.styles.includes(n)) {
      return group.styles
        .filter((g) => g !== n)
        .map((g) => ({ style: g.toUpperCase(), brand: group.brand }));
    }
  }
  return [];
}

export interface ProductSearchVendorResult {
  /** Alias style number that produced the hit — null when the typed query hit directly. */
  aliasUsed: string | null;
  lookup: VendorLookupResult;
}

export interface ProductSearchResult {
  query: string;
  /** Aliases the search also tried (for the "also searched as…" UI cue). */
  aliasesTried: string[];
  vendors: ProductSearchVendorResult[];
}

async function searchOneVendor(
  vendor: VendorId,
  query: string,
  aliases: { style: string; brand: string }[],
): Promise<ProductSearchVendorResult> {
  const lookup = await vendorLookup(vendor, query);
  // An exact hit needs no alias help. A "closest" hit can be plain WRONG when
  // the query is a known alias (S&S resolves "G500" to Onna NN500 by fuzzy
  // search — the Gildan 5000 only surfaces via the alias), so aliases are
  // tried whenever the direct result is not exact; an exact alias hit wins.
  if (lookup.found && lookup.matchType === "exact") return { aliasUsed: null, lookup };
  let fallback: ProductSearchVendorResult | null = null;
  for (const alias of aliases) {
    const aliasLookup = await vendorLookup(vendor, alias.style, { brandHint: alias.brand });
    if (aliasLookup.found && aliasLookup.matchType === "exact") {
      return { aliasUsed: alias.style, lookup: aliasLookup };
    }
    if (aliasLookup.found && !fallback) {
      fallback = { aliasUsed: alias.style, lookup: aliasLookup };
    }
  }
  if (lookup.found) return { aliasUsed: null, lookup };
  return fallback ?? { aliasUsed: null, lookup };
}

/**
 * Search both vendors in parallel. A vendor failure (SOAP hang, credential
 * issue) degrades to a not-found entry with an error note rather than
 * failing the whole search — the other vendor's result is still useful.
 */
export async function productSearch(query: string): Promise<
  ProductSearchResult & { vendorErrors: { vendor: VendorId; error: string }[] }
> {
  const aliases = styleAliases(query);
  const vendorIds: VendorId[] = ["sanmar", "ss"];
  const vendorErrors: { vendor: VendorId; error: string }[] = [];
  const settled = await Promise.allSettled(
    vendorIds.map((v) => searchOneVendor(v, query, aliases)),
  );
  const vendors: ProductSearchVendorResult[] = settled.map((s, i) => {
    const vendor = vendorIds[i]!;
    if (s.status === "fulfilled") return s.value;
    const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
    vendorErrors.push({ vendor, error: msg });
    return {
      aliasUsed: null,
      lookup: {
        found: false,
        matchType: "none",
        vendor,
        styleQueried: query,
        styleId: null,
        styleName: null,
        brand: null,
        title: null,
        styleImage: null,
        colors: [],
        cached: false,
        fetchedAt: new Date().toISOString(),
      },
    };
  });
  return { query, aliasesTried: aliases.map((a) => a.style), vendors, vendorErrors };
}

/** Line items of a synced Printavo order, for the invoice stock-check mode. */
export interface FinderOrderLineItem {
  id: string;
  itemNumber: string | null;
  color: string | null;
  description: string | null;
  brand: string | null;
  items: number;
  sizes: { size: string; count: number }[];
}

export interface FinderOrder {
  orderId: string;
  visualId: number;
  orderType: string;
  nickname: string | null;
  customerCompany: string | null;
  contactName: string | null;
  statusName: string | null;
  lineItems: FinderOrderLineItem[];
}

interface LineRow {
  li_id: string;
  item_number: string | null;
  color: string | null;
  description: string | null;
  brand: string | null;
  items: number;
  sizes: unknown;
  order_id: string;
  visual_id: number;
  order_type: string;
  nickname: string | null;
  customer_company: string | null;
  contact_name: string | null;
  status_name: string | null;
}

function normalizeSizes(raw: unknown): { size: string; count: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is { size?: unknown; count?: unknown } =>
        typeof s === "object" && s !== null,
    )
    .map((s) => ({
      size: String(s.size ?? "")
        .replace(/^size_/i, "")
        .toUpperCase(),
      count: Number(s.count ?? 0),
    }))
    .filter((s) => s.size.length > 0 && s.count > 0);
}

/**
 * Load a synced order + line items by visual ID (local mirror only — never
 * the Printavo API). Invoices win over quotes when both share a visual ID.
 * Returns null when the mirror has no such order.
 */
export async function loadOrderLineItems(visualId: number): Promise<FinderOrder | null> {
  const rows = (await db.execute(sql`
    SELECT
      li.printavo_id AS li_id,
      li.item_number,
      li.color,
      li.description,
      li.brand,
      li.items,
      li.sizes,
      o.printavo_id AS order_id,
      o.visual_id,
      o.order_type,
      o.nickname,
      o.customer_company,
      o.contact_name,
      o.status_name
    FROM pv_orders o
    LEFT JOIN pv_line_items li ON li.order_id = o.printavo_id
    WHERE o.visual_id = ${visualId}
    ORDER BY (o.order_type = 'invoice') DESC, o.printavo_created_at DESC NULLS LAST, li.printavo_id
  `)) as unknown as { rows: LineRow[] };
  if (rows.rows.length === 0) return null;
  const first = rows.rows[0]!;
  const order: FinderOrder = {
    orderId: first.order_id,
    visualId: first.visual_id,
    orderType: first.order_type,
    nickname: first.nickname,
    customerCompany: first.customer_company,
    contactName: first.contact_name,
    statusName: first.status_name,
    lineItems: [],
  };
  for (const r of rows.rows) {
    if (r.order_id !== order.orderId) continue; // quote sharing the visual id
    if (r.li_id === null) continue; // order with no line items (LEFT JOIN)
    order.lineItems.push({
      id: r.li_id,
      itemNumber: r.item_number,
      color: r.color,
      description: r.description,
      brand: r.brand,
      items: Number(r.items ?? 0),
      sizes: normalizeSizes(r.sizes),
    });
  }
  return order;
}
