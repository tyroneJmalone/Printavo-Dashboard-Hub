export type PantoneSource = "vendor_documentation" | "staff_verification";

type QueryClient = {
  query: (text: string, values: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};

export function normalizePantoneUpdate(
  code: string | null,
  source: PantoneSource | null,
): { code: string | null; source: PantoneSource | null } | null {
  const normalizedCode = code?.trim() || null;
  if ((normalizedCode === null) !== (source === null)) return null;
  return { code: normalizedCode, source };
}

/**
 * The conflict update is deliberately limited to verification columns. Web
 * swatch measurements belong to the worker and must remain untouched.
 */
export async function upsertVerifiedPantone(
  client: QueryClient,
  identity: { vendor: string; styleName: string; colorName: string },
  verification: { code: string | null; source: PantoneSource | null },
): Promise<any | null> {
  const result = await client.query(
    `INSERT INTO catalog_color_evidence
       (vendor,style_name,color_name,verified_pantone_code,verified_pantone_source,updated_at)
     SELECT p.vendor,p.style_name,c.color_name,$4,$5,now()
       FROM catalog_products p JOIN catalog_colors c ON c.product_id=p.id
      WHERE p.vendor=$1 AND p.style_name=$2 AND c.color_name=$3
     ON CONFLICT (vendor,style_name,color_name) DO UPDATE SET
       verified_pantone_code=EXCLUDED.verified_pantone_code,
       verified_pantone_source=EXCLUDED.verified_pantone_source,
       updated_at=now()
     RETURNING vendor,style_name,color_name,verified_pantone_code,verified_pantone_source,updated_at evidence_updated_at`,
    [identity.vendor, identity.styleName, identity.colorName, verification.code, verification.source],
  );
  return result.rowCount ? result.rows[0] : null;
}