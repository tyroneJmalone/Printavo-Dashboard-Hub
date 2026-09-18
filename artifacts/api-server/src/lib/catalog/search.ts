import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { COLOR_FAMILIES } from "./tagger";
import { mapCatalogSearchRow, type CatalogSearchHit } from "./searchResult";
export { mapCatalogSearchRow } from "./searchResult";
export type { CatalogSearchColor, CatalogSearchHit } from "./searchResult";

/**
 * Deterministic catalog search — tokenized matching over the local catalog,
 * no AI at query time. Query tokens are parsed into:
 *  - color-family terms ("light blue", "green") → expand to every color name
 *    mapped to that family; product must carry a matching color; matched
 *    colors are returned for swatch display
 *  - text tokens → each must hit brand, style, title, category, tags
 *    (imported ∪ staff add − staff remove), description, or a color name
 * Ranking favors style/brand hits, then tags, title, category, colors,
 * description; exact style-number matches float to the top.
 */

export interface CatalogSearchParams {
  query: string;
  vendor?: string;
  brand?: string;
  category?: string;
  colorFamily?: string;
  priceMin?: number;
  priceMax?: number;
  limit?: number;
  offset?: number;
}

const FAMILY_SET = new Set<string>(COLOR_FAMILIES);

/** Greedily pull known color families out of the token stream (bigrams first). */
export function parseQuery(query: string): { families: string[]; tokens: string[] } {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9/&'-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    // "women's"/"womens'" → womens ; "men's" → mens
    .map((w) => w.replace(/'s$/, "s").replace(/'/g, ""));
  const families: string[] = [];
  const tokens: string[] = [];
  let i = 0;
  while (i < words.length) {
    const bigram = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : null;
    if (bigram && FAMILY_SET.has(bigram)) {
      families.push(bigram);
      i += 2;
      continue;
    }
    const w = words[i]!;
    if (FAMILY_SET.has(w)) families.push(w);
    else tokens.push(w);
    i += 1;
  }
  return { families: Array.from(new Set(families)), tokens };
}

/** Normalize common gender words so tokens hit the canonical tags. */
function normToken(t: string): string {
  if (t === "women" || t === "woman" || t === "ladies" || t === "lady") return "womens";
  if (t === "men" || t === "man") return "mens";
  if (t === "kids" || t === "kid" || t === "children" || t === "childrens") return "youth";
  if (t === "tee" || t === "tees" || t === "tshirt" || t === "tshirts" || t === "shirt" || t === "shirts")
    return "t-shirt";
  if (t === "polos") return "polo";
  if (t === "hoodies" || t === "hoody") return "hoodie";
  if (t === "hats" || t === "caps" || t === "cap") return "hat";
  if (t === "jackets") return "jacket";
  if (t === "crop" || t === "cropped") return "crop top";
  return t;
}

export async function searchCatalog(params: CatalogSearchParams): Promise<{ total: number; hits: CatalogSearchHit[] }> {
  const { families, tokens: rawTokens } = parseQuery(params.query ?? "");
  const tokens = Array.from(new Set(rawTokens.map(normToken)));
  const allFamilies = [...families];
  if (params.colorFamily && FAMILY_SET.has(params.colorFamily.toLowerCase()))
    allFamilies.push(params.colorFamily.toLowerCase());
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  const conds = [sql`p.discontinued = false`];
  if (params.vendor) conds.push(sql`p.vendor = ${params.vendor}`);
  if (params.brand) conds.push(sql`p.brand ILIKE ${params.brand}`);
  if (params.category) conds.push(sql`p.category ILIKE ${params.category}`);
  if (params.priceMin !== undefined) conds.push(sql`p.price_min >= ${params.priceMin}`);
  if (params.priceMax !== undefined) conds.push(sql`p.price_min <= ${params.priceMax}`);

  // Every requested family must be present among the product's colors.
  for (const fam of Array.from(new Set(allFamilies))) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM catalog_colors cc
      JOIN catalog_color_families cf ON cf.norm_name = cc.norm_name
      WHERE cc.product_id = p.id AND cf.families @> ARRAY[${fam}]::text[]
    )`);
  }

  // Each text token must match somewhere on the product (AND semantics).
  const scoreParts = [sql`0`];
  for (const tok of tokens) {
    const like = `%${tok}%`;
    conds.push(sql`(
      p.style_name ILIKE ${like} OR p.brand ILIKE ${like} OR p.title ILIKE ${like}
      OR p.category ILIKE ${like} OR p.description ILIKE ${like}
      OR EXISTS (SELECT 1 FROM unnest(p.eff_tags) t WHERE t ILIKE ${like})
      OR EXISTS (SELECT 1 FROM catalog_colors cc2 WHERE cc2.product_id = p.id AND cc2.color_name ILIKE ${like})
    )`);
    scoreParts.push(sql`
      (CASE WHEN lower(p.style_name) = ${tok} THEN 60 WHEN p.style_name ILIKE ${like} THEN 15 ELSE 0 END)
      + (CASE WHEN p.brand ILIKE ${like} THEN 10 ELSE 0 END)
      + (CASE WHEN EXISTS (SELECT 1 FROM unnest(p.eff_tags) t WHERE t = ${tok}) THEN 12
              WHEN EXISTS (SELECT 1 FROM unnest(p.eff_tags) t WHERE t ILIKE ${like}) THEN 8 ELSE 0 END)
      + (CASE WHEN p.title ILIKE ${like} THEN 6 ELSE 0 END)
      + (CASE WHEN p.category ILIKE ${like} THEN 4 ELSE 0 END)
      + (CASE WHEN EXISTS (SELECT 1 FROM catalog_colors cc3 WHERE cc3.product_id = p.id AND cc3.color_name ILIKE ${like}) THEN 3 ELSE 0 END)
      + (CASE WHEN p.description ILIKE ${like} THEN 1 ELSE 0 END)`);
  }
  // Family matches contribute too, so pure color searches still rank sanely.
  for (const fam of Array.from(new Set(allFamilies))) {
    scoreParts.push(sql`5`);
    void fam;
  }

  const whereSql = sql.join(conds, sql` AND `);
  const scoreSql = sql.join(scoreParts, sql` + `);

  // Matched colors: colors in a requested family (or family-named by a token);
  // when nothing color-ish was asked, return all available colors.
  const famArr = Array.from(new Set(allFamilies));
  const matchedColorsSql =
    famArr.length > 0
      ? sql`(
          SELECT COALESCE(json_agg(json_build_object(
            'colorName', cc.color_name, 'swatchImage', cc.swatch_image,
            'productImage', cc.product_image, 'families', COALESCE(cf.families, '{}'))
            ORDER BY cc.color_name), '[]'::json)
          FROM catalog_colors cc
          LEFT JOIN catalog_color_families cf ON cf.norm_name = cc.norm_name
          WHERE cc.product_id = p.id AND cf.families && ARRAY[${sql.join(famArr.map((f) => sql`${f}`), sql`, `)}]::text[]
        )`
      : sql`(
          SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT json_build_object(
              'colorName', cc.color_name, 'swatchImage', cc.swatch_image,
              'productImage', cc.product_image, 'families', COALESCE(cf.families, '{}')) AS x
            FROM catalog_colors cc
            LEFT JOIN catalog_color_families cf ON cf.norm_name = cc.norm_name
            WHERE cc.product_id = p.id ORDER BY cc.color_name
          ) sub
        )`;
  const colorsSql = sql`(
    SELECT COALESCE(json_agg(json_build_object(
      'colorName', cc.color_name, 'swatchImage', cc.swatch_image,
      'productImage', cc.product_image, 'families', COALESCE(cf.families, '{}'))
      ORDER BY cc.color_name), '[]'::json)
    FROM catalog_colors cc
    LEFT JOIN catalog_color_families cf ON cf.norm_name = cc.norm_name
    WHERE cc.product_id = p.id
  )`;

  const res = (await db.execute(sql`
    WITH base AS (
      SELECT cp.*,
        (SELECT COALESCE(
            (SELECT array_agg(DISTINCT t) FROM (
              SELECT unnest(cp.tags) AS t
              UNION SELECT unnest(o.add_tags)
              EXCEPT SELECT unnest(o.remove_tags)
            ) eff), '{}'::text[])
         FROM (SELECT 1) one
         LEFT JOIN catalog_tag_overrides o ON o.vendor = cp.vendor AND o.style_name = cp.style_name
        ) AS eff_tags
      FROM catalog_products cp
    ),
    filtered AS (
      SELECT p.*, (${scoreSql}) AS score
      FROM base p
      WHERE ${whereSql}
    )
    SELECT p.*,
      (SELECT count(*) FROM catalog_colors cc WHERE cc.product_id = p.id) AS color_count,
      ${matchedColorsSql} AS matched_colors,
      ${colorsSql} AS colors,
      count(*) OVER () AS total
    FROM filtered p
    ORDER BY p.score DESC, p.brand NULLS LAST, p.style_name
    LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as { rows: Record<string, unknown>[] };

  const rows = res.rows;
  const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
  return {
    total,
    hits: rows.map(mapCatalogSearchRow),
  };
}

/** Distinct filter values for the search UI dropdowns. */
export async function catalogFilters() {
  const res = (await db.execute(sql`
    SELECT
      (SELECT array_agg(DISTINCT brand ORDER BY brand) FROM catalog_products WHERE brand IS NOT NULL AND discontinued = false) AS brands,
      (SELECT array_agg(DISTINCT category ORDER BY category) FROM catalog_products WHERE category IS NOT NULL AND discontinued = false) AS categories
  `)) as unknown as { rows: { brands: string[] | null; categories: string[] | null }[] };
  return {
    brands: res.rows[0]?.brands ?? [],
    categories: res.rows[0]?.categories ?? [],
    colorFamilies: [...COLOR_FAMILIES],
  };
}
