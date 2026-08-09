import { db, catalogColorFamiliesTable, catalogProductsTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import type { Logger } from "pino";
import { normColorName } from "./importers";

/**
 * AI-assisted catalog tagging — runs at IMPORT time only, never per search.
 * Two passes:
 *  1. Color families: every unique vendor color name is mapped once to a
 *     small fixed set of standard families, stored in catalog_color_families
 *     (staff-corrected rows are never overwritten).
 *  2. Product attributes: garment type / gender / fabric / keyword tags
 *     derived from brand+title+category+description, stored on the product.
 * Searches match these stored tags — fast, deterministic, no AI per query.
 */

const MODEL = "gpt-5.6-terra";

/** Canonical color families — the ONLY values allowed in the map. */
export const COLOR_FAMILIES = [
  "black",
  "white",
  "grey",
  "silver",
  "blue",
  "light blue",
  "navy",
  "royal blue",
  "teal",
  "green",
  "dark green",
  "light green",
  "olive",
  "red",
  "dark red",
  "maroon",
  "orange",
  "yellow",
  "gold",
  "purple",
  "lavender",
  "pink",
  "brown",
  "tan",
  "cream",
  "natural",
  "charcoal",
  "camo",
  "multi",
  "neon",
] as const;

/** Canonical attribute tags the AI may assign (searches match these). */
const GARMENT_TYPES = [
  "t-shirt", "long sleeve", "tank top", "crop top", "polo", "hoodie", "sweatshirt",
  "crewneck", "quarter zip", "full zip", "jacket", "vest", "flannel", "woven shirt",
  "dress shirt", "hat", "beanie", "trucker hat", "bag", "tote", "backpack", "apron",
  "shorts", "pants", "joggers", "leggings", "socks", "towel", "blanket", "onesie",
  "dress", "skirt", "rain jacket", "windbreaker", "safety", "scrubs",
] as const;
const GENDERS = ["mens", "womens", "unisex", "youth", "toddler", "infant"] as const;
const FABRICS = [
  "cotton", "polyester", "blend", "tri-blend", "fleece", "performance",
  "moisture wicking", "organic", "recycled", "denim", "canvas", "nylon", "wool",
] as const;

const ALLOWED_TAGS = new Set<string>([...GARMENT_TYPES, ...GENDERS, ...FABRICS]);
const ALLOWED_FAMILIES = new Set<string>(COLOR_FAMILIES);

export interface TagCounts {
  colorsTagged: number;
  productsTagged: number;
}

async function chatJson(system: string, user: string): Promise<Record<string, unknown>> {
  const res = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 8192,
  });
  const text = res.choices[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const COLOR_BATCH = 80;

/** Map every not-yet-tagged unique color name to color families. */
export async function tagColorFamilies(log: Logger): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT c.norm_name, MIN(c.color_name) AS color_name
    FROM catalog_colors c
    LEFT JOIN catalog_color_families f ON f.norm_name = c.norm_name
    WHERE f.norm_name IS NULL
    GROUP BY c.norm_name
  `)) as unknown as { rows: { norm_name: string; color_name: string }[] };
  const pending = rows.rows;
  if (pending.length === 0) return 0;
  log.info({ pending: pending.length }, "catalog color-family tagging");
  let tagged = 0;
  const system = `You classify apparel color names into standard color families. Allowed families (use EXACTLY these strings): ${COLOR_FAMILIES.join(", ")}. Each color gets 1-3 families — a heathered navy is ["navy","blue"]; "Sky" is ["light blue","blue"]; "Sapphire" is ["blue"]; "Forest" is ["dark green","green"]. Include the broad family alongside a specific one so broad searches still hit. Respond with JSON: {"colors": {"<name>": ["family", ...], ...}}. Unrecognizable/heather-only names get your best guess; never invent families outside the list.`;
  for (let i = 0; i < pending.length; i += COLOR_BATCH) {
    const batch = pending.slice(i, i + COLOR_BATCH);
    try {
      const out = await chatJson(system, JSON.stringify({ colors: batch.map((b) => b.color_name) }));
      const map = (out.colors ?? {}) as Record<string, unknown>;
      const values: { normName: string; colorName: string; families: string[] }[] = [];
      for (const b of batch) {
        const raw = map[b.color_name];
        const families = Array.isArray(raw)
          ? raw.map((f) => String(f).toLowerCase().trim()).filter((f) => ALLOWED_FAMILIES.has(f))
          : [];
        values.push({ normName: b.norm_name, colorName: b.color_name, families });
      }
      for (const v of values) {
        await db
          .insert(catalogColorFamiliesTable)
          .values({ normName: v.normName, colorName: v.colorName, families: v.families, source: "ai" })
          .onConflictDoNothing(); // staff rows and races both win over this pass
        tagged += 1;
      }
    } catch (err) {
      log.warn({ err, batchStart: i }, "color-family batch failed — continuing");
    }
  }
  return tagged;
}

const PRODUCT_BATCH = 30;

/** Assign attribute tags to products that have none yet. */
export async function tagProductAttributes(log: Logger): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT id, brand, title, category, description
    FROM catalog_products
    WHERE tags = '{}' AND discontinued = false
    ORDER BY id
  `)) as unknown as {
    rows: { id: number; brand: string | null; title: string | null; category: string | null; description: string | null }[];
  };
  const pending = rows.rows;
  if (pending.length === 0) return 0;
  log.info({ pending: pending.length }, "catalog product-attribute tagging");
  let tagged = 0;
  const system = `You tag wholesale apparel products for search. Allowed tags (use EXACTLY these strings): garment types [${GARMENT_TYPES.join(", ")}], genders [${GENDERS.join(", ")}], fabrics [${FABRICS.join(", ")}]. For each product pick every tag that applies: exactly one garment type when clear, one or more genders (default "unisex" for adult styles unless clearly gendered; add "youth" only for youth styles), fabrics only when stated or strongly implied. Respond with JSON: {"products": {"<id>": ["tag", ...], ...}}.`;
  for (let i = 0; i < pending.length; i += PRODUCT_BATCH) {
    const batch = pending.slice(i, i + PRODUCT_BATCH);
    try {
      const out = await chatJson(
        system,
        JSON.stringify({
          products: batch.map((p) => ({
            id: p.id,
            brand: p.brand,
            title: p.title,
            category: p.category,
            description: p.description?.slice(0, 300) ?? null,
          })),
        }),
      );
      const map = (out.products ?? {}) as Record<string, unknown>;
      for (const p of batch) {
        const raw = map[String(p.id)];
        const tags = Array.isArray(raw)
          ? Array.from(new Set(raw.map((t) => String(t).toLowerCase().trim()).filter((t) => ALLOWED_TAGS.has(t))))
          : [];
        if (tags.length === 0) continue; // leave '{}' so a later pass retries
        await db
          .update(catalogProductsTable)
          .set({ tags, updatedAt: new Date() })
          .where(eq(catalogProductsTable.id, p.id));
        tagged += 1;
      }
    } catch (err) {
      log.warn({ err, batchStart: i }, "product-attribute batch failed — continuing");
    }
  }
  return tagged;
}

export async function runTaggingPass(log: Logger): Promise<TagCounts> {
  const colorsTagged = await tagColorFamilies(log);
  const productsTagged = await tagProductAttributes(log);
  return { colorsTagged, productsTagged };
}
