import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import {
  ListCatalogPantonesQueryParams,
  ListCatalogPantonesResponse,
  SetCatalogPantoneBody,
  SetCatalogPantoneResponse,
} from "@workspace/api-zod";
import {
  normalizePantoneUpdate,
  upsertVerifiedPantone,
} from "../lib/catalog/pantoneVerification";

const router: IRouter = Router();

function responseRow(row: any) {
  return {
    vendor: row.vendor,
    styleName: row.style_name,
    colorName: row.color_name,
    brand: row.brand ?? null,
    title: row.title ?? null,
    swatchImage: row.swatch_image ?? null,
    productImage: row.product_image ?? null,
    pantoneCode: row.verified_pantone_code ?? null,
    pantoneSource: row.verified_pantone_source ?? null,
    updatedAt: row.evidence_updated_at?.toISOString?.() ?? row.evidence_updated_at ?? null,
  };
}

router.get("/purchasing/catalog/pantones", async (req: Request, res: Response): Promise<void> => {
  const parsed = ListCatalogPantonesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Pantone search query" });
    return;
  }
  const { q, vendor } = parsed.data;
  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const search = q?.trim() || null;
  try {
    const result = await pool.query(
      `WITH matching AS (
         SELECT p.vendor,p.style_name,p.brand,p.title,c.color_name,c.swatch_image,c.product_image
           FROM catalog_products p
           JOIN catalog_colors c ON c.product_id=p.id
          WHERE ($1::text IS NULL OR p.vendor=$1)
            AND ($2::text IS NULL OR concat_ws(' ',p.vendor,p.style_name,p.brand,p.title,c.color_name) ILIKE '%' || $2 || '%')
       ), counted AS (
         SELECT count(*)::int total FROM matching
       )
       SELECT m.*,e.verified_pantone_code,e.verified_pantone_source,e.updated_at evidence_updated_at,
              counted.total
         FROM matching m CROSS JOIN counted
         LEFT JOIN catalog_color_evidence e
           ON e.vendor=m.vendor AND e.style_name=m.style_name AND e.color_name=m.color_name
        ORDER BY m.vendor,m.style_name,m.color_name
        LIMIT $3 OFFSET $4`,
      [vendor ?? null, search, limit, offset],
    );
    const total = result.rows[0]?.total ?? (
      await pool.query(
        `SELECT count(*)::int total
           FROM catalog_products p JOIN catalog_colors c ON c.product_id=p.id
          WHERE ($1::text IS NULL OR p.vendor=$1)
            AND ($2::text IS NULL OR concat_ws(' ',p.vendor,p.style_name,p.brand,p.title,c.color_name) ILIKE '%' || $2 || '%')`,
        [vendor ?? null, search],
      )
    ).rows[0]?.total ?? 0;
    res.json(ListCatalogPantonesResponse.parse({
      items: result.rows.map(responseRow),
      total,
      limit,
      offset,
    }));
  } catch (err) {
    req.log.error({ err }, "Catalog Pantone list failed");
    res.status(500).json({ error: "Failed to list catalog Pantones" });
  }
});

router.put("/purchasing/catalog/pantones", async (req: Request, res: Response): Promise<void> => {
  const parsed = SetCatalogPantoneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Pantone update" });
    return;
  }
  const data = parsed.data;
  const normalized = normalizePantoneUpdate(data.pantoneCode, data.pantoneSource);
  if (!normalized) {
    res.status(400).json({ error: "Pantone code and source must both be provided or both be null" });
    return;
  }
  try {
    const saved = await upsertVerifiedPantone(
      pool,
      { vendor: data.vendor, styleName: data.styleName.trim(), colorName: data.colorName.trim() },
      normalized,
    );
    if (!saved) {
      res.status(404).json({ error: "Exact imported vendor/style/color identity not found" });
      return;
    }
    const detail = await pool.query(
      `SELECT p.vendor,p.style_name,p.brand,p.title,c.color_name,c.swatch_image,c.product_image,
              e.verified_pantone_code,e.verified_pantone_source,e.updated_at evidence_updated_at
         FROM catalog_products p JOIN catalog_colors c ON c.product_id=p.id
         JOIN catalog_color_evidence e
           ON e.vendor=p.vendor AND e.style_name=p.style_name AND e.color_name=c.color_name
        WHERE p.vendor=$1 AND p.style_name=$2 AND c.color_name=$3`,
      [data.vendor, data.styleName.trim(), data.colorName.trim()],
    );
    res.json(SetCatalogPantoneResponse.parse(responseRow(detail.rows[0])));
  } catch (err) {
    req.log.error({ err }, "Catalog Pantone update failed");
    res.status(500).json({ error: "Failed to update catalog Pantone" });
  }
});

export default router;