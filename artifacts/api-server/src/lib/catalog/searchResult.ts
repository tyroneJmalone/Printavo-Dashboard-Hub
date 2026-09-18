export interface CatalogSearchColor {
  colorName: string;
  swatchImage: string | null;
  productImage: string | null;
  families: string[];
}

export interface CatalogSearchHit {
  id: number;
  vendor: string;
  styleName: string;
  brand: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  styleImage: string | null;
  priceMin: number | null;
  priceMax: number | null;
  sizes: string[];
  tags: string[];
  discontinued: boolean;
  matchedColors: CatalogSearchColor[];
  colors: CatalogSearchColor[];
  colorCount: number;
  score: number;
}

/** Convert the database's snake-case result without changing either color set. */
export function mapCatalogSearchRow(r: Record<string, unknown>): CatalogSearchHit {
  return {
    id: Number(r.id),
    vendor: String(r.vendor),
    styleName: String(r.style_name),
    brand: (r.brand as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    styleImage: (r.style_image as string | null) ?? null,
    priceMin: r.price_min === null ? null : Number(r.price_min),
    priceMax: r.price_max === null ? null : Number(r.price_max),
    sizes: (r.sizes as string[]) ?? [],
    tags: (r.eff_tags as string[]) ?? [],
    discontinued: Boolean(r.discontinued),
    matchedColors: (r.matched_colors as CatalogSearchColor[]) ?? [],
    colors: (r.colors as CatalogSearchColor[]) ?? [],
    colorCount: Number(r.color_count ?? 0),
    score: Number(r.score ?? 0),
  };
}