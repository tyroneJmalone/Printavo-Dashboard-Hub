import type { SanMarProductEntry } from "@workspace/sanmar";

export interface ProductUpsert {
  vendor: "sanmar" | "ss";
  styleName: string;
  styleId: string | null;
  brand: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  styleImage: string | null;
  priceMin: number | null;
  priceMax: number | null;
  sizes: string[];
  colors: { colorName: string; swatchImage: string | null; productImage: string | null }[];
}

/** Strip vendor HTML descriptions to plain text for the local catalog. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map fields already returned by SanMar's Product Info SOAP response. */
export function mapSanMarProduct(
  entries: SanMarProductEntry[],
  colorMap: Map<string, { swatch: string | null; photo: string | null }>,
  sizeSet: Set<string>,
  priceMin: number | null,
  priceMax: number | null,
): ProductUpsert {
  const first = entries[0];
  if (!first) throw new Error("Cannot map an empty SanMar product response");
  return {
    vendor: "sanmar",
    styleName: first.style,
    styleId: null,
    brand: first.brandName,
    title: first.productTitle,
    description: first.productDescription ? stripHtml(first.productDescription).slice(0, 2000) : null,
    category: first.category,
    styleImage: colorMap.values().next().value?.photo ?? null,
    priceMin,
    priceMax,
    sizes: Array.from(sizeSet),
    colors: Array.from(colorMap.entries()).map(([colorName, im]) => ({
      colorName,
      swatchImage: im.swatch,
      productImage: im.photo,
    })),
  };
}