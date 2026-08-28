import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCollectionBody,
  UpdateCollectionBody,
  AddCollectionItemsBody,
  UpdateCollectionItemBody,
} from "@workspace/api-zod";
import {
  db,
  collectionsTable,
  collectionItemsTable,
  catalogProductsTable,
  pvCustomersTable,
  type Collection,
} from "@workspace/db";
import { and, desc, eq, sql, inArray } from "drizzle-orm";
import { pool } from "@workspace/db";
import { PreviewCollectionPaletteBody, CreateCollectionFromSuggestionBody } from "@workspace/api-zod";
import { dedupeStyleInputs, rankPaletteColor, type PaletteColor } from "../lib/catalog/paletteSuggestions";

/**
 * Curation collections (Product Finder phase 3).
 * Hub-owned data; the optional customer link is a plain Printavo customer id
 * (no FK into the synced mirror tables — sync owns their lifecycle).
 * Item display data is joined live from the local catalog so collections
 * never go stale when the catalog refreshes.
 */

const router: IRouter = Router();
type SqlClient = { query: (...args: unknown[]) => Promise<any>; release: () => void };

const SIZE_ORDER = [
  "XXS", "XS", "XS/S", "S", "S/M", "M", "M/L", "L", "L/XL", "XL",
  "XL/2XL", "2XL", "XXL", "2/3XL", "3XL", "XXXL", "3/4XL", "4XL", "5XL", "6XL",
];
export function orderedSizes(sizes: string[]): string[] {
  return [...new Set(sizes)].sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a.toUpperCase()), bi = SIZE_ORDER.indexOf(b.toUpperCase());
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
  });
}
export function sizeRange(sizes: string[]): string | null {
  const ordered = orderedSizes(sizes);
  return ordered.length ? ordered.length === 1 ? ordered[0]! : `${ordered[0]}–${ordered.at(-1)}` : null;
}

/** Same display-name rule as the customer directory routes. */
const CUSTOMER_NAME_SQL = sql<string | null>`COALESCE(
  NULLIF(${pvCustomersTable.companyName}, ''),
  ${pvCustomersTable.data} -> 'primaryContact' ->> 'fullName'
)`;

async function customerName(printavoCustomerId: string | null): Promise<string | null> {
  if (!printavoCustomerId) return null;
  const [row] = await db
    .select({ name: CUSTOMER_NAME_SQL })
    .from(pvCustomersTable)
    .where(eq(pvCustomersTable.printavoId, printavoCustomerId))
    .limit(1);
  return row?.name ?? null;
}

async function loadDetail(id: string): Promise<Record<string, unknown> | null> {
  const [coll] = await db
    .select()
    .from(collectionsTable)
    .where(eq(collectionsTable.id, id))
    .limit(1);
  if (!coll) return null;

  const items = await db
    .select({
      id: collectionItemsTable.id,
      vendor: collectionItemsTable.vendor,
      styleName: collectionItemsTable.styleName,
      colors: collectionItemsTable.colors,
      note: collectionItemsTable.note,
      paletteMatchSnapshot: collectionItemsTable.paletteMatchSnapshot,
      createdAt: collectionItemsTable.createdAt,
      brand: catalogProductsTable.brand,
      title: catalogProductsTable.title,
      styleImage: catalogProductsTable.styleImage,
      priceMin: catalogProductsTable.priceMin,
      priceMax: catalogProductsTable.priceMax,
      discontinued: catalogProductsTable.discontinued,
      catalogId: catalogProductsTable.id,
    })
    .from(collectionItemsTable)
    .leftJoin(
      catalogProductsTable,
      and(
        eq(catalogProductsTable.vendor, collectionItemsTable.vendor),
        eq(catalogProductsTable.styleName, collectionItemsTable.styleName),
      ),
    )
    .where(eq(collectionItemsTable.collectionId, id))
    .orderBy(collectionItemsTable.createdAt);

  return {
    id: coll.id,
    name: coll.name,
    printavoCustomerId: coll.printavoCustomerId,
    customerName: await customerName(coll.printavoCustomerId),
    notes: coll.notes,
    createdByEmail: coll.createdByEmail,
    createdAt: coll.createdAt.toISOString(),
    updatedAt: coll.updatedAt.toISOString(),
    items: items.map((it) => ({
      id: it.id,
      vendor: it.vendor,
      styleName: it.styleName,
      colors: it.colors,
      note: it.note,
       paletteMatchSnapshot: it.paletteMatchSnapshot ?? null,
      brand: it.brand,
      title: it.title,
      styleImage: it.styleImage,
      priceMin: it.priceMin != null ? Number(it.priceMin) : null,
      priceMax: it.priceMax != null ? Number(it.priceMax) : null,
      discontinued: it.discontinued ?? false,
      inCatalog: it.catalogId != null,
      createdAt: it.createdAt.toISOString(),
    })),
  };
}

/** Transaction-client detail load so a successful commit always has a response ready. */
async function loadDetailWithClient(client: SqlClient, id: string): Promise<Record<string, unknown>> {
  const coll = await client.query(
    `SELECT c.*, COALESCE(NULLIF(p.company_name, ''), p.data -> 'primaryContact' ->> 'fullName') customer_name
       FROM collections c LEFT JOIN pv_customers p ON p.printavo_id = c.printavo_customer_id WHERE c.id = $1`, [id],
  );
  if (!coll.rows[0]) throw new Error("Created collection could not be loaded");
  const row = coll.rows[0];
  const itemRows = await client.query(
     `SELECT ci.id, ci.vendor, ci.style_name, ci.colors, ci.note, ci.palette_match_snapshot, ci.created_at,
            cp.brand, cp.title, cp.style_image, cp.price_min, cp.price_max, cp.discontinued, cp.id catalog_id
       FROM collection_items ci LEFT JOIN catalog_products cp ON cp.vendor = ci.vendor AND cp.style_name = ci.style_name
      WHERE ci.collection_id = $1 ORDER BY ci.created_at`, [id],
  );
  return {
    id: row.id, name: row.name, printavoCustomerId: row.printavo_customer_id, customerName: row.customer_name,
    notes: row.notes, createdByEmail: row.created_by_email, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    items: itemRows.rows.map((item: any) => ({
       id: item.id, vendor: item.vendor, styleName: item.style_name, colors: item.colors, note: item.note, paletteMatchSnapshot: item.palette_match_snapshot ?? null,
      brand: item.brand, title: item.title, styleImage: item.style_image,
      priceMin: item.price_min == null ? null : Number(item.price_min), priceMax: item.price_max == null ? null : Number(item.price_max),
      discontinued: item.discontinued ?? false, inCatalog: item.catalog_id != null, createdAt: item.created_at.toISOString(),
    })),
  };
}

function sendDetail(res: Response, detail: Record<string, unknown> | null): void {
  if (!detail) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }
  res.json(detail);
}

type NewItem = {
  vendor: "sanmar" | "ss";
  styleName: string;
  colors?: string[] | undefined;
  note?: string | null | undefined;
};
class ReviewValidationError extends Error {}

/** Insert items, merging into existing (colors unioned; note kept unless new). */
async function mergeItems(collectionId: string, items: NewItem[]): Promise<void> {
  if (items.length === 0) return;
  const existing = await db
    .select()
    .from(collectionItemsTable)
    .where(eq(collectionItemsTable.collectionId, collectionId));
  const byKey = new Map(existing.map((e) => [`${e.vendor}|${e.styleName}`, e]));

  // Group the incoming batch by (vendor, style) first — a "Save All" batch can
  // legitimately contain the same style twice (e.g. two chosen colors).
  const grouped = new Map<string, NewItem>();
  for (const item of items) {
    const styleName = item.styleName.trim();
    if (!styleName) continue;
    const key = `${item.vendor}|${styleName}`;
    const prev = grouped.get(key);
    if (prev) {
      prev.colors = [...(prev.colors ?? []), ...(item.colors ?? [])];
      if (item.note !== undefined && item.note !== null && item.note.trim() !== "") prev.note = item.note;
    } else {
      grouped.set(key, { ...item, styleName, colors: [...(item.colors ?? [])] });
    }
  }

  for (const item of grouped.values()) {
    const styleName = item.styleName;
    const colors = Array.from(new Set((item.colors ?? []).map((c) => c.trim()).filter(Boolean)));
    const prev = byKey.get(`${item.vendor}|${styleName}`);
    if (prev) {
      await db
        .update(collectionItemsTable)
        .set({
          colors: Array.from(new Set([...prev.colors, ...colors])),
          note: item.note !== undefined && item.note !== null && item.note.trim() !== "" ? item.note : prev.note,
        })
        .where(eq(collectionItemsTable.id, prev.id));
    } else {
      await db.insert(collectionItemsTable).values({
        collectionId,
        vendor: item.vendor,
        styleName,
        colors,
        note: item.note ?? null,
      });
    }
  }
  await touch(collectionId);
}

async function touch(collectionId: string): Promise<void> {
  await db
    .update(collectionsTable)
    .set({ updatedAt: new Date() })
    .where(eq(collectionsTable.id, collectionId));
}

router.get("/collections", (req, res) => {
  const customerId =
    typeof req.query.customerId === "string" && req.query.customerId.trim() !== ""
      ? req.query.customerId.trim()
      : null;
  (async () => {
    const colls: Collection[] = await db
      .select()
      .from(collectionsTable)
      .where(customerId ? eq(collectionsTable.printavoCustomerId, customerId) : undefined)
      .orderBy(desc(collectionsTable.updatedAt));

    const ids = colls.map((c) => c.id);
    const counts = new Map<string, number>();
    const previews = new Map<string, string[]>();
    if (ids.length > 0) {
      const rows = await db
        .select({
          collectionId: collectionItemsTable.collectionId,
          styleImage: catalogProductsTable.styleImage,
        })
        .from(collectionItemsTable)
        .leftJoin(
          catalogProductsTable,
          and(
            eq(catalogProductsTable.vendor, collectionItemsTable.vendor),
            eq(catalogProductsTable.styleName, collectionItemsTable.styleName),
          ),
        )
        .where(inArray(collectionItemsTable.collectionId, ids))
        .orderBy(collectionItemsTable.createdAt);
      for (const r of rows) {
        counts.set(r.collectionId, (counts.get(r.collectionId) ?? 0) + 1);
        if (r.styleImage) {
          const list = previews.get(r.collectionId) ?? [];
          if (list.length < 4) {
            list.push(r.styleImage);
            previews.set(r.collectionId, list);
          }
        }
      }
    }

    // Resolve customer names in one query.
    const custIds = Array.from(
      new Set(colls.map((c) => c.printavoCustomerId).filter((x): x is string => !!x)),
    );
    const nameMap = new Map<string, string | null>();
    if (custIds.length > 0) {
      const rows = await db
        .select({ id: pvCustomersTable.printavoId, name: CUSTOMER_NAME_SQL })
        .from(pvCustomersTable)
        .where(inArray(pvCustomersTable.printavoId, custIds));
      for (const r of rows) nameMap.set(r.id, r.name);
    }

    return colls.map((c) => ({
      id: c.id,
      name: c.name,
      printavoCustomerId: c.printavoCustomerId,
      customerName: c.printavoCustomerId ? (nameMap.get(c.printavoCustomerId) ?? null) : null,
      notes: c.notes,
      createdByEmail: c.createdByEmail,
      itemCount: counts.get(c.id) ?? 0,
      previewImages: previews.get(c.id) ?? [],
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  })()
    .then((collections) => res.json({ collections }))
    .catch((err) => {
      req.log.error({ err }, "Collection list failed");
      res.status(500).json({ error: "Failed to list collections" });
    });
});

router.post("/collections", (req: Request, res) => {
  const parsed = CreateCollectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid collection payload" });
    return;
  }
  (async () => {
    const [created] = await db
      .insert(collectionsTable)
      .values({
        name: parsed.data.name.trim(),
        printavoCustomerId: parsed.data.printavoCustomerId ?? null,
        notes: parsed.data.notes ?? null,
        createdByEmail: req.staff?.email ?? null,
      })
      .returning();
    await mergeItems(created!.id, (parsed.data.items ?? []) as NewItem[]);
    return loadDetail(created!.id);
  })()
    .then((detail) => res.status(201).json(detail))
    .catch((err) => {
      req.log.error({ err }, "Collection create failed");
      res.status(500).json({ error: "Failed to create collection" });
    });
});

router.post("/collections/palette-preview", async (req: Request, res): Promise<void> => {
  const parsed = PreviewCollectionPaletteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid palette preview payload" }); return; }
  try {
    const customerId = parsed.data.printavoCustomerId.trim();
    const customer = await pool.query("SELECT 1 FROM pv_customers WHERE printavo_id = $1", [customerId]);
    if (!customer.rowCount) { res.status(404).json({ error: "Customer not found" }); return; }
    const paletteResult = await pool.query(
       `SELECT c.id, a.role, c.name, c.hex, c.rgb, c.pantone_code AS "pantoneCode" FROM customer_branding_colors a
       JOIN branding_colors c ON c.id = a.color_id WHERE a.printavo_customer_id = $1 AND c.active = true ORDER BY a.role`, [customerId]);
    const palette = paletteResult.rows as PaletteColor[];
    if (!palette.length) { res.status(400).json({ error: "Customer has no configured active branding colors" }); return; }
    const suggestions: unknown[] = [], unresolved: unknown[] = [], ambiguous: unknown[] = [];
    for (const input of dedupeStyleInputs(parsed.data.styles)) {
      const match = /^(sanmar|ss)\s*:\s*(.+)$/i.exec(input);
      const vendor = match?.[1]?.toLowerCase() ?? null, style = (match?.[2] ?? input).trim();
      const products = await pool.query(
         `SELECT id, vendor, style_name, style_id, brand, title, description, style_image, sizes FROM catalog_products
         WHERE discontinued = false AND lower(style_name) = lower($1) ${vendor ? "AND vendor = $2" : ""} ORDER BY vendor`,
        vendor ? [style, vendor] : [style]);
      if (!products.rowCount) { unresolved.push({ input, reason: "No active exact style match." }); continue; }
      if (!vendor && products.rowCount > 1) { ambiguous.push({ input, candidates: products.rows.map((p) => ({ vendor: p.vendor, styleName: p.style_name, brand: p.brand, title: p.title })) }); continue; }
      const product = products.rows[0]!;
      const colors = await pool.query(
         `SELECT cc.color_name, cc.norm_name, cc.swatch_image, cc.product_image, COALESCE(cf.families, '{}'::text[]) families,
                 e.status evidence_status, e.lab_l, e.lab_a, e.lab_b, e.rgb_r,e.rgb_g,e.rgb_b,e.source_swatch_url,e.source_swatch_hash,e.reason,e.color_profile,e.illuminant,e.measured_at,e.confidence evidence_confidence,
                 e.quality evidence_quality, e.measurement_method, e.algorithm_version,
                 e.verified_pantone_code, e.verified_pantone_source
          FROM catalog_colors cc LEFT JOIN catalog_color_families cf ON cf.norm_name = cc.norm_name
          LEFT JOIN catalog_color_evidence e ON e.vendor=$2 AND e.style_name=$3 AND e.color_name=cc.color_name
          WHERE cc.product_id = $1 ORDER BY cc.color_name LIMIT 100`, [product.id, product.vendor, product.style_name]);
       const alternatives = colors.rows.map((c) => {
         const x = rankPaletteColor({ colorName: c.color_name, normName: c.norm_name, swatchImage: c.swatch_image, productImage: c.product_image, families: c.families,
           evidence: c.evidence_status ? { status: c.evidence_status, lab: c.lab_l == null ? null : [Number(c.lab_l), Number(c.lab_a), Number(c.lab_b)], rgb: c.rgb_r == null ? null : [c.rgb_r,c.rgb_g,c.rgb_b], sourceSwatchUrl:c.source_swatch_url,sourceSwatchHash:c.source_swatch_hash,reason:c.reason,profile:c.color_profile,illuminant:c.illuminant,measuredAt:c.measured_at?.toISOString?.() ?? c.measured_at ?? null, confidence: c.evidence_confidence, quality: c.evidence_quality, method: c.measurement_method, algorithmVersion: c.algorithm_version } : null }, palette);
         return { ...x, garmentPantoneCode: c.verified_pantone_code ?? null, garmentPantoneSource: c.verified_pantone_source ?? null };
       });
      const ranked = [...alternatives].sort((a, b) => b.score - a.score || a.colorName.localeCompare(b.colorName));
       // Preview remains read-fast. It prioritizes the most relevant missing
       // swatches for the paced worker instead of downloading vendor images
       // inside this request.
       const queuedEvidence = ranked
         .filter((c) => c.swatchImage && (!c.evidence || c.evidence.status === "pending" || c.evidence.status === "error"))
         .map((c, index) => ({ colorName: c.colorName, swatchImage: c.swatchImage, priority: index < 12 ? 100 : 20 }));
       if (queuedEvidence.length > 0) {
         await pool.query(
           `INSERT INTO catalog_color_evidence (vendor,style_name,color_name,status,source_swatch_url,priority)
            SELECT $1,$2,q.color_name,'pending',q.swatch_image,q.priority
            FROM jsonb_to_recordset($3::jsonb) AS q(color_name text,swatch_image text,priority integer)
            ON CONFLICT (vendor,style_name,color_name) DO UPDATE SET
              priority=CASE WHEN catalog_color_evidence.status IN ('pending','error')
                THEN GREATEST(catalog_color_evidence.priority,EXCLUDED.priority)
                ELSE catalog_color_evidence.priority END,
              updated_at=CASE WHEN catalog_color_evidence.status IN ('pending','error')
                THEN now() ELSE catalog_color_evidence.updated_at END`,
           [product.vendor, product.style_name, JSON.stringify(queuedEvidence.map((item) => ({
             color_name: item.colorName,
             swatch_image: item.swatchImage,
             priority: item.priority,
           })))],
         );
       }
       suggestions.push({ input, vendor: product.vendor, styleName: product.style_name, styleId: product.style_id, brand: product.brand, title: product.title, description: product.description, styleImage: product.style_image, sizes: orderedSizes(product.sizes ?? []), sizeRange: sizeRange(product.sizes ?? []), colors: ranked.slice(0, 12), alternatives: ranked.slice(0, 100) });
    }
    res.json({ printavoCustomerId: customerId, palette: palette.map((c) => ({ id: c.id, role: c.role, name: c.name, hex: c.hex, pantoneCode: c.pantoneCode ?? null })), suggestions, unresolved, ambiguous });
  } catch (err) { req.log.error({ err }, "Palette preview failed"); res.status(500).json({ error: "Failed to preview palette suggestions" }); }
});

router.post("/collections/from-suggestion", async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateCollectionFromSuggestionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid reviewed suggestion payload" }); return; }
  const data = parsed.data;
  const reviewedItems = new Map<string, { vendor: "sanmar" | "ss"; styleName: string; colors: string[] }>();
  for (const item of data.items) {
    const styleName = item.styleName.trim(), key = `${item.vendor}|${styleName.toLowerCase()}`;
    const current = reviewedItems.get(key);
    if (current) current.colors = [...new Set([...current.colors, ...item.colors.map((color) => color.trim()).filter(Boolean)])];
    else reviewedItems.set(key, { vendor: item.vendor, styleName, colors: [...new Set(item.colors.map((color) => color.trim()).filter(Boolean))] });
  }
  let client: SqlClient | undefined;
  let committed = false;
  let savedDetail: Record<string, unknown> | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (!(await client.query("SELECT 1 FROM pv_customers WHERE printavo_id = $1", [data.printavoCustomerId])).rowCount) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Customer not found" }); return;
    }
    if (!(await client.query(
      `SELECT 1 FROM customer_branding_colors a JOIN branding_colors c ON c.id = a.color_id
       WHERE a.printavo_customer_id = $1 AND c.active = true LIMIT 1`, [data.printavoCustomerId],
    )).rowCount) throw new ReviewValidationError("Customer has no configured active branding colors");
    const paletteRows = (await client.query(
       `SELECT c.id,a.role,c.name,c.hex,c.rgb,c.pantone_code AS "pantoneCode" FROM customer_branding_colors a
       JOIN branding_colors c ON c.id=a.color_id WHERE a.printavo_customer_id=$1 AND c.active=true ORDER BY a.role`,
      [data.printavoCustomerId],
    )).rows as PaletteColor[];
    const snapshots = new Map<string, unknown>();
    for (const item of reviewedItems.values()) {
      const product = await client.query("SELECT id, style_name, style_id, brand, title, description, style_image, sizes FROM catalog_products WHERE vendor = $1 AND lower(style_name) = lower($2) AND discontinued = false", [item.vendor, item.styleName]);
      if (product.rowCount !== 1) throw new ReviewValidationError(`Reviewed style is unavailable: ${item.vendor}:${item.styleName}`);
      item.styleName = product.rows[0].style_name;
      const valid = await client.query("SELECT count(*)::int count FROM catalog_colors WHERE product_id = $1 AND color_name = ANY($2::text[])", [product.rows[0].id, item.colors]);
      if (valid.rows[0].count !== item.colors.length) throw new ReviewValidationError(`Reviewed color is unavailable: ${item.vendor}:${item.styleName}`);
      const chosen = await client.query(
        `SELECT cc.color_name,cc.norm_name,cc.swatch_image,cc.product_image,COALESCE(cf.families,'{}'::text[]) families,
          e.status,e.lab_l,e.lab_a,e.lab_b,e.rgb_r,e.rgb_g,e.rgb_b,e.source_swatch_url,e.source_swatch_hash,e.reason,e.color_profile,e.illuminant,e.measured_at,e.confidence,e.quality,e.measurement_method,e.algorithm_version,e.verified_pantone_code,e.verified_pantone_source
         FROM catalog_colors cc LEFT JOIN catalog_color_families cf ON cf.norm_name=cc.norm_name
         LEFT JOIN catalog_color_evidence e ON e.vendor=$2 AND e.style_name=$3 AND e.color_name=cc.color_name
         WHERE cc.product_id=$1 AND cc.color_name=ANY($4::text[]) ORDER BY cc.color_name`,
        [product.rows[0].id, item.vendor, item.styleName, item.colors],
      );
      const matches = chosen.rows.map((c: any) => {
        const match = rankPaletteColor({ colorName: c.color_name, normName: c.norm_name, swatchImage: c.swatch_image, productImage: c.product_image, families: c.families,
          evidence: c.status ? { status: c.status, lab: c.lab_l == null ? null : [Number(c.lab_l), Number(c.lab_a), Number(c.lab_b)], rgb:c.rgb_r == null ? null : [c.rgb_r,c.rgb_g,c.rgb_b],sourceSwatchUrl:c.source_swatch_url,sourceSwatchHash:c.source_swatch_hash,reason:c.reason,profile:c.color_profile,illuminant:c.illuminant,measuredAt:c.measured_at?.toISOString?.() ?? c.measured_at ?? null, confidence: c.confidence, quality: c.quality, method: c.measurement_method, algorithmVersion: c.algorithm_version } : null }, paletteRows);
        return { ...match, garmentPantoneCode: c.verified_pantone_code ?? null, garmentPantoneSource: c.verified_pantone_source ?? null };
      });
      snapshots.set(`${item.vendor}|${item.styleName.toLowerCase()}`, {
        version: "palette-suggestion-v1",
        customerPalette: paletteRows.map((c) => ({ id: c.id, role: c.role, name: c.name, hex: c.hex, pantoneCode: c.pantoneCode ?? null })),
        product: { vendor: item.vendor, styleName: item.styleName, styleId: product.rows[0].style_id, brand: product.rows[0].brand, title: product.rows[0].title, description: product.rows[0].description, styleImage: product.rows[0].style_image, sizes: orderedSizes(product.rows[0].sizes ?? []), sizeRange: sizeRange(product.rows[0].sizes ?? []) },
        matches,
      });
    }
    const provenance = `Palette suggestions reviewed for customer ${data.printavoCustomerId}.`;
    const notes = [data.notes?.trim(), provenance].filter(Boolean).join("\n");
    const created = await client.query("INSERT INTO collections (name, printavo_customer_id, notes, created_by_email) VALUES ($1,$2,$3,$4) RETURNING id", [data.name.trim(), data.printavoCustomerId, notes, req.staff?.email ?? null]);
    for (const item of reviewedItems.values()) await client.query("INSERT INTO collection_items (collection_id,vendor,style_name,colors,palette_match_snapshot) VALUES ($1,$2,$3,$4,$5::jsonb)", [created.rows[0].id, item.vendor, item.styleName, item.colors, JSON.stringify(snapshots.get(`${item.vendor}|${item.styleName.toLowerCase()}`) ?? null)]);
    savedDetail = await loadDetailWithClient(client, created.rows[0].id);
    await client.query("COMMIT");
    committed = true;
  } catch (err) {
    if (!committed) await client?.query("ROLLBACK").catch(() => undefined);
    if (err instanceof ReviewValidationError) { res.status(400).json({ error: err.message }); return; }
    req.log.error({ err }, "Reviewed palette collection save failed");
    res.status(500).json({ error: "Failed to save reviewed suggestion" });
    return;
  } finally { client?.release(); }
  // Deliberately outside the transaction error boundary: persistence has
  // committed and the complete response was already built from that snapshot.
  if (!committed || !savedDetail) {
    req.log.error("Committed palette collection has no response snapshot");
    res.status(500).json({ error: "Failed to save reviewed suggestion" });
    return;
  }
  res.status(201).json(savedDetail);
});

router.get("/collections/:id", (req, res) => {
  loadDetail(req.params.id)
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection fetch failed");
      res.status(500).json({ error: "Failed to fetch collection" });
    });
});

router.patch("/collections/:id", (req, res) => {
  const parsed = UpdateCollectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid collection update" });
    return;
  }
  const set: Partial<typeof collectionsTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) set.name = parsed.data.name.trim();
  if ("printavoCustomerId" in req.body) set.printavoCustomerId = parsed.data.printavoCustomerId ?? null;
  if ("notes" in req.body) set.notes = parsed.data.notes ?? null;
  (async () => {
    const updated = await db
      .update(collectionsTable)
      .set(set)
      .where(eq(collectionsTable.id, req.params.id))
      .returning({ id: collectionsTable.id });
    if (updated.length === 0) return null;
    return loadDetail(req.params.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection update failed");
      res.status(500).json({ error: "Failed to update collection" });
    });
});

router.delete("/collections/:id", (req, res) => {
  db.delete(collectionsTable)
    .where(eq(collectionsTable.id, req.params.id))
    .returning({ id: collectionsTable.id })
    .then((rows) => {
      if (rows.length === 0) {
        res.status(404).json({ error: "Collection not found" });
        return;
      }
      res.json({ ok: true });
    })
    .catch((err) => {
      req.log.error({ err }, "Collection delete failed");
      res.status(500).json({ error: "Failed to delete collection" });
    });
});

router.post("/collections/:id/items", (req, res) => {
  const parsed = AddCollectionItemsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid items payload" });
    return;
  }
  (async () => {
    const [coll] = await db
      .select({ id: collectionsTable.id })
      .from(collectionsTable)
      .where(eq(collectionsTable.id, req.params.id))
      .limit(1);
    if (!coll) return null;
    await mergeItems(coll.id, parsed.data.items as NewItem[]);
    return loadDetail(coll.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection item add failed");
      res.status(500).json({ error: "Failed to add items" });
    });
});

router.patch("/collections/:id/items/:itemId", (req, res) => {
  const parsed = UpdateCollectionItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid item update" });
    return;
  }
  const set: Partial<typeof collectionItemsTable.$inferInsert> = {};
  if (parsed.data.colors !== undefined) {
    set.colors = Array.from(new Set(parsed.data.colors.map((c: string) => c.trim()).filter(Boolean)));
  }
  if ("note" in req.body) set.note = parsed.data.note ?? null;
  (async () => {
    const updated = await db
      .update(collectionItemsTable)
      .set(set)
      .where(
        and(
          eq(collectionItemsTable.id, req.params.itemId),
          eq(collectionItemsTable.collectionId, req.params.id),
        ),
      )
      .returning({ id: collectionItemsTable.id });
    if (updated.length === 0) return null;
    await touch(req.params.id);
    return loadDetail(req.params.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection item update failed");
      res.status(500).json({ error: "Failed to update item" });
    });
});

router.delete("/collections/:id/items/:itemId", (req, res) => {
  (async () => {
    const deleted = await db
      .delete(collectionItemsTable)
      .where(
        and(
          eq(collectionItemsTable.id, req.params.itemId),
          eq(collectionItemsTable.collectionId, req.params.id),
        ),
      )
      .returning({ id: collectionItemsTable.id });
    if (deleted.length === 0) return null;
    await touch(req.params.id);
    return loadDetail(req.params.id);
  })()
    .then((detail) => sendDetail(res, detail))
    .catch((err) => {
      req.log.error({ err }, "Collection item delete failed");
      res.status(500).json({ error: "Failed to remove item" });
    });
});

export default router;
