import { db, catalogProductsTable, catalogColorsTable } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import { SanMarClient } from "@workspace/sanmar";
import { SSClient } from "@workspace/ss-activewear";
import type { Logger } from "pino";

/**
 * Nightly vendor catalog importers (Product Finder phase 2).
 * Slow-moving product data only — prices, colors, images, sizes. Live
 * warehouse inventory is deliberately NOT imported (fetched fresh at view
 * time via the phase-1 lookup endpoints).
 *
 * Upserts are keyed (vendor, style_name); colors are replaced per product on
 * every import (staff input never lives on these rows — corrections are in
 * catalog_color_families / catalog_tag_overrides, keyed by name, so a full
 * re-import cannot lose them). Styles missing from a SUCCESSFUL enumeration
 * are flagged discontinued rather than deleted (tags/overrides keep working
 * and the team can still find recently dropped garments).
 */

export interface ImportCounts {
  productsUpserted: number;
  colorsUpserted: number;
  discontinuedCount: number;
}

export function normColorName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Strip vendor HTML (S&S descriptions are <ul><li>…) to plain text. */
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

const SS_IMAGE_BASE = "https://www.ssactivewear.com/";
function ssImageUrl(path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return SS_IMAGE_BASE + path.replace(/^\/+/, "");
}

interface ProductUpsert {
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

async function upsertProduct(p: ProductUpsert): Promise<void> {
  const now = new Date();
  const [row] = await db
    .insert(catalogProductsTable)
    .values({
      vendor: p.vendor,
      styleName: p.styleName,
      styleId: p.styleId,
      brand: p.brand,
      title: p.title,
      description: p.description,
      category: p.category,
      styleImage: p.styleImage,
      priceMin: p.priceMin?.toFixed(2) ?? null,
      priceMax: p.priceMax?.toFixed(2) ?? null,
      sizes: p.sizes,
      discontinued: false,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [catalogProductsTable.vendor, catalogProductsTable.styleName],
      set: {
        styleId: p.styleId,
        brand: p.brand,
        title: p.title,
        description: p.description,
        category: p.category,
        styleImage: p.styleImage,
        priceMin: p.priceMin?.toFixed(2) ?? null,
        priceMax: p.priceMax?.toFixed(2) ?? null,
        sizes: p.sizes,
        discontinued: false,
        lastSeenAt: now,
        updatedAt: now,
        // tags are intentionally NOT touched here — the AI tagging pass owns
        // them and re-import must not wipe existing attribute tags.
      },
    })
    .returning({ id: catalogProductsTable.id });
  const productId = row!.id;
  await db.delete(catalogColorsTable).where(eq(catalogColorsTable.productId, productId));
  if (p.colors.length > 0) {
    await db.insert(catalogColorsTable).values(
      p.colors.map((c) => ({
        productId,
        colorName: c.colorName,
        normName: normColorName(c.colorName),
        swatchImage: c.swatchImage,
        productImage: c.productImage,
      })),
    );
  }
}

/** Flag styles the enumeration no longer contains. Only call after a run
 *  that successfully enumerated the vendor (a partial run must not mass-flag). */
async function markDiscontinued(vendor: string, seenStyles: string[]): Promise<number> {
  if (seenStyles.length === 0) return 0; // safety: empty enumeration = something is wrong
  // Drizzle sql params don't serialize JS arrays as Postgres arrays — build
  // an explicit ARRAY[...] constructor (see search.ts for the same pattern).
  // Compare case-insensitively: enumeration style ids and persisted style
  // names can differ in casing between vendor services.
  const upper = Array.from(new Set(seenStyles.map((s) => s.toUpperCase())));
  const seenArr = sql`ARRAY[${sql.join(upper.map((s) => sql`${s}`), sql`, `)}]::text[]`;
  const res = (await db.execute(sql`
    UPDATE catalog_products
    SET discontinued = true, updated_at = now()
    WHERE vendor = ${vendor}
      AND discontinued = false
      AND NOT (upper(style_name) = ANY(${seenArr}))
  `)) as unknown as { rowCount?: number };
  return res.rowCount ?? 0;
}

const SS_CONCURRENCY = 5;

/** Styles already imported very recently (e.g. an interrupted seed that was
 *  restarted) can be skipped — makes long imports resumable across restarts. */
async function recentlyImported(vendor: string, withinMs: number): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - withinMs);
  const rows = await db
    .select({ styleName: catalogProductsTable.styleName })
    .from(catalogProductsTable)
    .where(
      and(
        eq(catalogProductsTable.vendor, vendor),
        sql`${catalogProductsTable.lastSeenAt} > ${cutoff}`,
      ),
    );
  return new Set(rows.map((r) => r.styleName));
}

const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

/** S&S throttles bursts with 503s — retry with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/503|429|timeout|ECONNRESET|fetch failed/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** a + Math.random() * 500));
    }
  }
  throw lastErr;
}

export async function importSSCatalog(
  client: SSClient,
  log: Logger,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportCounts> {
  const styles = await withRetry(() => client.listAllStyles());
  const skip = await recentlyImported("ss", RESUME_WINDOW_MS);
  log.info({ styles: styles.length, alreadyFresh: skip.size }, "S&S catalog enumeration");
  let productsUpserted = 0;
  let colorsUpserted = 0;
  let failures = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < styles.length) {
      const i = idx++;
      const s = styles[i]!;
      if (skip.has(s.styleName)) continue;
      try {
        const products = await withRetry(() => client.getProducts(s.styleID));
        const colorMap = new Map<string, { swatch: string | null; photo: string | null }>();
        const sizeSet = new Set<string>();
        let priceMin: number | null = null;
        let priceMax: number | null = null;
        for (const p of products) {
          if (!colorMap.has(p.colorName)) {
            colorMap.set(p.colorName, {
              swatch: ssImageUrl(p.colorSwatchImage),
              photo: ssImageUrl(p.colorFrontImage),
            });
          }
          sizeSet.add(p.sizeName.toUpperCase());
          if (p.piecePrice !== null) {
            priceMin = priceMin === null ? p.piecePrice : Math.min(priceMin, p.piecePrice);
            priceMax = priceMax === null ? p.piecePrice : Math.max(priceMax, p.piecePrice);
          }
        }
        await upsertProduct({
          vendor: "ss",
          styleName: s.styleName,
          styleId: String(s.styleID),
          brand: s.brandName || null,
          title: s.title,
          description: s.description ? stripHtml(s.description).slice(0, 2000) : null,
          category: s.baseCategory,
          styleImage: ssImageUrl(s.styleImage),
          priceMin,
          priceMax,
          sizes: Array.from(sizeSet),
          colors: Array.from(colorMap.entries()).map(([colorName, im]) => ({
            colorName,
            swatchImage: im.swatch,
            productImage: im.photo,
          })),
        });
        productsUpserted += 1;
        colorsUpserted += colorMap.size;
      } catch (err) {
        failures += 1;
        if (failures <= 20) log.warn({ err, style: s.styleName }, "S&S style import failed");
      }
      if (onProgress && (i + 1) % 250 === 0) onProgress(i + 1, styles.length);
    }
  };
  await Promise.all(Array.from({ length: SS_CONCURRENCY }, worker));
  // Enumeration succeeded — styles absent from it are discontinued. Skip the
  // flagging when too many per-style fetches failed (vendor flakiness must
  // not look like a mass discontinuation… flagging keys on enumeration, not
  // fetches, so this is just belt-and-braces logging).
  const discontinuedCount = await markDiscontinued("ss", styles.map((s) => s.styleName));
  log.info({ productsUpserted, colorsUpserted, failures, discontinuedCount }, "S&S catalog import done");
  return { productsUpserted, colorsUpserted, discontinuedCount };
}

export async function importSanMarCatalog(
  client: SanMarClient,
  log: Logger,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportCounts> {
  const styles = await client.getSellableStyles();
  const skip = await recentlyImported("sanmar", RESUME_WINDOW_MS);
  log.info({ styles: styles.length, alreadyFresh: skip.size }, "SanMar catalog enumeration");
  let productsUpserted = 0;
  let colorsUpserted = 0;
  let failures = 0;
  // SanMar SOAP dislikes bursts — strictly sequential.
  for (let i = 0; i < styles.length; i++) {
    const styleNum = styles[i]!;
    if (skip.has(styleNum)) {
      continue; // fresh from an interrupted run — enumeration already covers it
    }
    try {
      const entries = await client.getProductInfo(styleNum);
      if (entries.length === 0) continue;
      const first = entries[0]!;
      const colorMap = new Map<string, { swatch: string | null; photo: string | null }>();
      const sizeSet = new Set<string>();
      let priceMin: number | null = null;
      let priceMax: number | null = null;
      for (const e of entries) {
        if (!colorMap.has(e.catalogColor)) {
          colorMap.set(e.catalogColor, { swatch: e.colorSwatchImage, photo: e.colorProductImage });
        }
        sizeSet.add(e.size.toUpperCase());
        // SanMar regular cost = casePrice (piecePrice is the broken-case tier).
        const cost = e.casePrice ?? e.piecePrice;
        if (cost !== null) {
          priceMin = priceMin === null ? cost : Math.min(priceMin, cost);
          priceMax = priceMax === null ? cost : Math.max(priceMax, cost);
        }
      }
      await upsertProduct({
        vendor: "sanmar",
        styleName: first.style,
        styleId: null,
        brand: first.brandName,
        title: first.productTitle,
        description: null,
        category: null,
        styleImage: colorMap.values().next().value?.photo ?? null,
        priceMin,
        priceMax,
        sizes: Array.from(sizeSet),
        colors: Array.from(colorMap.entries()).map(([colorName, im]) => ({
          colorName,
          swatchImage: im.swatch,
          productImage: im.photo,
        })),
      });
      productsUpserted += 1;
      colorsUpserted += colorMap.size;
    } catch (err) {
      failures += 1;
      if (failures <= 20) log.warn({ err, style: styleNum }, "SanMar style import failed");
    }
    if (onProgress && (i + 1) % 100 === 0) onProgress(i + 1, styles.length);
  }
  // Discontinuation keys on the ENUMERATION (like S&S) — a style whose
  // detail fetch failed transiently is still sellable and must never be
  // flagged. Also skip entirely when the SOAP session was widescale-flaky.
  let discontinuedCount = 0;
  if (failures < styles.length * 0.1) {
    discontinuedCount = await markDiscontinued("sanmar", styles);
  } else {
    log.warn({ failures, total: styles.length }, "SanMar import too flaky — skipping discontinued flagging");
  }
  log.info({ productsUpserted, colorsUpserted, failures, discontinuedCount }, "SanMar catalog import done");
  return { productsUpserted, colorsUpserted, discontinuedCount };
}
