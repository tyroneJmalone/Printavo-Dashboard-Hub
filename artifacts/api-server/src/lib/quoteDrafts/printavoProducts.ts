/** Exact catalog identity matching. Never infer merchandise identity from fuzzy search rank. */
export interface ProductIdentity {
  style: string;
  color: string;
  brand?: string | null;
  vendor?: "sanmar" | "ss" | null;
}
export interface PrintavoProduct {
  id: string;
  itemNumber: string | null;
  color: string | null;
  brand: string | null;
  catalog: { id: string; name: string } | null;
}
export class PrintavoProductResolutionError extends Error {}
const normalized = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function matchPrintavoProduct(identity: ProductIdentity, products: PrintavoProduct[]): PrintavoProduct {
  const label = `${identity.style} / ${identity.color}`;
  if (!normalized(identity.style) || !normalized(identity.color)) {
    throw new PrintavoProductResolutionError(`${label}: enter a style and color to verify the Printavo catalog connection.`);
  }
  const matches = [...new Map(products.filter((p) => {
    if (!p.id || !p.catalog || normalized(p.itemNumber) !== normalized(identity.style) ||
        normalized(p.color) !== normalized(identity.color)) return false;
    if (identity.brand && normalized(p.brand) !== normalized(identity.brand)) return false;
    if (identity.vendor === "sanmar") return normalized(p.catalog.name) === "sanmar";
    if (identity.vendor === "ss") return ["s&s", "s&s activewear"].includes(normalized(p.catalog.name));
    return true;
  }).map((p) => [p.id, p])).values()];
  if (matches.length !== 1) {
    throw new PrintavoProductResolutionError(
      `${label}: ${matches.length ? "multiple exact Printavo catalog products were found" : "no exact Printavo catalog product was found"}${identity.vendor ? ` for ${identity.vendor === "sanmar" ? "SanMar" : "S&S"}` : ""}. Nothing was sent. Check the vendor, brand, style and color; if unresolved, select the product directly in Printavo. Search results may be incomplete.`,
    );
  }
  return matches[0]!;
}

export type ProductQuery = <T>(query: string) => Promise<T>;

/** Request-scoped caching only: reverify every preview/commit, do not trust an old catalog snapshot. */
export async function resolvePrintavoProducts(identities: ProductIdentity[], query: ProductQuery): Promise<PrintavoProduct[]> {
  const cache = new Map<string, Promise<PrintavoProduct[]>>();
  const search = (term: string) => {
    if (!cache.has(term)) cache.set(term, (async () => {
      const result = await query<{ products: { nodes: PrintavoProduct[] } }>(
        `query { products(query: ${JSON.stringify(term)}, first: 100) { nodes { id itemNumber color brand catalog { id name } } } }`,
      );
      if (!Array.isArray(result?.products?.nodes)) throw new Error("Incomplete product search response");
      return result.products.nodes;
    })());
    return cache.get(term)!;
  };
  const resolved: PrintavoProduct[] = [];
  for (const identity of identities) {
    if (!identity.style.trim() || !identity.color.trim()) matchPrintavoProduct(identity, []);
    let candidates: PrintavoProduct[];
    try {
      // Printavo has broken pagination and broad search semantics; examine both
      // bounded searches, then exact-match fields, never fabricate cursors.
      candidates = [
        ...await search(identity.style.trim()),
        ...await search(`${identity.style.trim()} ${identity.color.trim()}`),
      ];
    } catch {
      throw new PrintavoProductResolutionError(`${identity.style}: Printavo catalog lookup failed. Nothing was sent; try previewing again later.`);
    }
    resolved.push(matchPrintavoProduct(identity, candidates));
  }
  return resolved;
}
