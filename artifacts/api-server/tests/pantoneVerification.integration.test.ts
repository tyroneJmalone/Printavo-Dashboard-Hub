import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool } from "@workspace/db";
import { upsertVerifiedPantone } from "../src/lib/catalog/pantoneVerification";

test("Pantone verification survives imported-color replacement and preserves snapshots", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const imported = await client.query(
      `SELECT p.id product_id,p.vendor,p.style_name,c.color_name,c.norm_name,c.swatch_image,c.product_image
         FROM catalog_products p JOIN catalog_colors c ON c.product_id=p.id
        ORDER BY p.updated_at DESC,c.color_name LIMIT 1`,
    );
    assert.ok(imported.rowCount, "Integration test requires at least one imported vendor/style/color");
    const color = imported.rows[0]!;
    const code = `TEST-${randomUUID().slice(0, 8)} C`;
    const identity = { vendor: color.vendor, styleName: color.style_name, colorName: color.color_name };

    await upsertVerifiedPantone(client, identity, { code, source: "staff_verification" });

    // Catalog import replaces imported color rows. Evidence has no FK to these
    // replaceable rows, so it must remain keyed by vendor/style/color.
    await client.query("DELETE FROM catalog_colors WHERE product_id=$1 AND color_name=$2", [color.product_id, color.color_name]);
    await client.query(
      `INSERT INTO catalog_colors (product_id,color_name,norm_name,swatch_image,product_image)
       VALUES ($1,$2,$3,$4,$5)`,
      [color.product_id, color.color_name, color.norm_name, color.swatch_image, color.product_image],
    );
    const joined = await client.query(
      `SELECT e.verified_pantone_code,e.verified_pantone_source
         FROM catalog_products p JOIN catalog_colors c ON c.product_id=p.id
         LEFT JOIN catalog_color_evidence e
           ON e.vendor=p.vendor AND e.style_name=p.style_name AND e.color_name=c.color_name
        WHERE p.vendor=$1 AND p.style_name=$2 AND c.color_name=$3`,
      [identity.vendor, identity.styleName, identity.colorName],
    );
    assert.deepEqual(joined.rows[0], {
      verified_pantone_code: code,
      verified_pantone_source: "staff_verification",
    });

    const collectionId = randomUUID();
    const snapshot = {
      version: "palette-suggestion-v1",
      matches: [{ colorName: identity.colorName, garmentPantoneCode: code, garmentPantoneSource: "staff_verification" }],
    };
    await client.query("INSERT INTO collections (id,name) VALUES ($1,$2)", [collectionId, `Pantone test ${collectionId}`]);
    await client.query(
      `INSERT INTO collection_items (collection_id,vendor,style_name,colors,palette_match_snapshot)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [collectionId, identity.vendor, identity.styleName, [identity.colorName], JSON.stringify(snapshot)],
    );
    const savedSnapshot = await client.query(
      "SELECT palette_match_snapshot FROM collection_items WHERE collection_id=$1",
      [collectionId],
    );
    assert.deepEqual(savedSnapshot.rows[0]!.palette_match_snapshot, snapshot);

    await upsertVerifiedPantone(client, identity, { code: null, source: null });
    const cleared = await client.query(
      `SELECT e.verified_pantone_code,e.verified_pantone_source
         FROM catalog_products p JOIN catalog_colors c ON c.product_id=p.id
         LEFT JOIN catalog_color_evidence e
           ON e.vendor=p.vendor AND e.style_name=p.style_name AND e.color_name=c.color_name
        WHERE p.vendor=$1 AND p.style_name=$2 AND c.color_name=$3`,
      [identity.vendor, identity.styleName, identity.colorName],
    );
    assert.deepEqual(cleared.rows[0], { verified_pantone_code: null, verified_pantone_source: null });

    await assert.rejects(
      client.query(
        `UPDATE catalog_color_evidence SET verified_pantone_code='MISMATCH C',
          verified_pantone_source=NULL WHERE vendor=$1 AND style_name=$2 AND color_name=$3`,
        [identity.vendor, identity.styleName, identity.colorName],
      ),
      (error: any) => error?.code === "23514",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});