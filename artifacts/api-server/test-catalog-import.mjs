// Real importer + Drizzle SQL, isolated PostgreSQL temp tables; no vendor/AI calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(new URL("../../lib/db/package.json", import.meta.url));
const { Client } = require("pg");
const bundle = await build({
  stdin: {
    contents: `export { upsertProduct } from "./src/lib/catalog/importers";
      export { useClient } from "@workspace/db";`,
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{
    name: "isolated-catalog-fixture",
    setup(b) {
      b.onLoad({ filter: /\/catalog\/importers\.ts$/ }, async args => ({
        // Expose the private entry point only in this test bundle.
        contents: await readFile(args.path, "utf8") + "\nexport { upsertProduct };",
        loader: "ts",
      }));
      b.onResolve({ filter: /^@workspace\/db$/ }, () => ({
        path: "fixture-db", namespace: "fixture",
      }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `import { drizzle } from "drizzle-orm/node-postgres";
          export * from "../../lib/db/src/schema/catalog";
          export let db;
          export function useClient(client) { db = drizzle(client); }`,
        resolveDir: import.meta.dirname,
        loader: "js",
      }));
    },
  }],
});
globalThis.require = require;
const { upsertProduct, useClient } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("catalog evidence UPSERT accepts nullable swatches and preserves evidence policy", async t => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL required for temporary-table fixtures");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_temp");
    for (const table of ["catalog_products", "catalog_colors", "catalog_color_evidence"]) {
      await client.query(`CREATE TEMP TABLE ${table}
        (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP`);
      // Copied serial defaults must never advance a public sequence.
      await client.query(`CREATE TEMP SEQUENCE ${table}_fixture_seq`);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN id
        SET DEFAULT nextval('pg_temp.${table}_fixture_seq')`);
    }
    useClient(client);
    // Any accidental network request from importer code must fail.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("External requests forbidden in catalog fixtures"); };
    try {
      const url = "https://fixture.invalid/swatch-a.jpg";
      const measured = {
        source_swatch_hash: "fixture-hash", rgb_r: 10, rgb_g: 20, rgb_b: 30,
        lab_l: 40, lab_a: 5, lab_b: -6, measurement_method: "fixture",
        color_profile: "sRGB", illuminant: "D65", confidence: "high",
        quality: "good", reason: "fixture reason", algorithm_version: "fixture-v1",
        attempts: 3, priority: 10,
        retry_at: new Date("2026-01-01T00:00:00Z"),
        measured_at: new Date("2026-01-01T00:00:00Z"),
      };
      const product = (swatch, colorName = "Navy / White") => ({
        vendor: "ss", styleName: "FIXTURE", styleId: "fixture", brand: "Fixture",
        title: "Fixture", description: null, category: null, styleImage: null,
        priceMin: null, priceMax: null, sizes: ["M"],
        colors: [{ colorName, swatchImage: swatch, productImage: null }],
      });
      const row = async () => (await client.query(
        "SELECT * FROM catalog_color_evidence WHERE color_name = 'Navy / White'",
      )).rows[0];
      const seed = async () => {
        const fields = Object.keys(measured);
        await client.query(`UPDATE catalog_color_evidence SET
          status='measured', verified_pantone_code='289 C',
          verified_pantone_source='staff_verification',
          ${fields.map((field, i) => `${field}=$${i + 1}`).join(",")}
          WHERE color_name='Navy / White'`, Object.values(measured));
      };
      const verifyReset = (r, status) => {
        assert.equal(r.status, status);
        for (const key of Object.keys(measured)) {
          assert.equal(r[key], ["attempts", "priority"].includes(key) ? 0 : null, key);
        }
        assert.equal(r.verified_pantone_code, "289 C");
        assert.equal(r.verified_pantone_source, "staff_verification");
      };

      await t.test("new URL inserts pending evidence with exact identity", async () => {
        await upsertProduct(product(`  ${url}  `));
        const r = await row();
        assert.equal(r.status, "pending");
        assert.equal(r.source_swatch_url, url);
        assert.equal(r.vendor, "ss");
        assert.equal(r.style_name, "FIXTURE");
        assert.equal(r.color_name, "Navy / White");
        assert.equal(r.verified_pantone_code, null);
      });
      await t.test("unchanged URL retains all measured and verified evidence", async () => {
        await seed();
        const before = await row();
        await upsertProduct(product(url));
        const after = await row();
        delete before.updated_at;
        delete after.updated_at;
        assert.deepEqual(after, before);
      });
      await t.test("changed URL resets measurements but keeps identity and verification", async () => {
        const id = (await row()).id;
        await upsertProduct(product("https://fixture.invalid/swatch-b.jpg"));
        const r = await row();
        verifyReset(r, "pending");
        assert.equal(r.id, id);
        assert.equal(r.source_swatch_url, "https://fixture.invalid/swatch-b.jpg");
      });
      await t.test("missing URL clears stale measurements and marks unavailable", async () => {
        await seed();
        await upsertProduct(product(null));
        const r = await row();
        verifyReset(r, "unavailable");
        assert.equal(r.source_swatch_url, null);
      });
      await t.test("unchanged missing/blank URL preserves existing evidence", async () => {
        const before = await row();
        await upsertProduct(product("   "));
        const after = await row();
        delete before.updated_at;
        delete after.updated_at;
        assert.deepEqual(after, before);
      });
      await t.test("new missing, undefined, empty and blank URLs insert unavailable", async () => {
        for (const [i, missing] of [null, undefined, "", "  "].entries()) {
          const color = `Missing ${i}`;
          await upsertProduct(product(missing, color));
          const r = (await client.query(
            "SELECT * FROM catalog_color_evidence WHERE color_name=$1", [color],
          )).rows[0];
          assert.equal(r.status, "unavailable");
          assert.equal(r.source_swatch_url, null);
          assert.equal(r.verified_pantone_code, null);
        }
      });
      await t.test("a URL arriving after absence schedules measurement", async () => {
        await upsertProduct(product(url));
        verifyReset(await row(), "pending");
        assert.equal((await row()).source_swatch_url, url);
        assert.equal((await client.query(
          "SELECT count(*)::int AS count FROM catalog_color_evidence",
        )).rows[0].count, 5, "color identities must not be merged or duplicated");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
