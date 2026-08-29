import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePantoneUpdate,
  upsertVerifiedPantone,
} from "../src/lib/catalog/pantoneVerification";

test("validation requires code and provenance together", () => {
  assert.equal(normalizePantoneUpdate("186 C", null), null);
  assert.equal(normalizePantoneUpdate(null, "vendor_documentation"), null);
  assert.equal(normalizePantoneUpdate("   ", "staff_verification"), null);
  assert.deepEqual(
    normalizePantoneUpdate(" 186 C ", "vendor_documentation"),
    { code: "186 C", source: "vendor_documentation" },
  );
  assert.deepEqual(normalizePantoneUpdate(null, null), { code: null, source: null });
});

test("upsert attaches and corrects only verified fields", async () => {
  let sql = "";
  let values: unknown[] = [];
  const client = {
    async query(text: string, params: unknown[]) {
      sql = text;
      values = params;
      return { rowCount: 1, rows: [{ verified_pantone_code: "186 C" }] };
    },
  };
  const row = await upsertVerifiedPantone(
    client,
    { vendor: "sanmar", styleName: "PC61", colorName: "Red" },
    { code: "186 C", source: "staff_verification" },
  );
  assert.equal(row.verified_pantone_code, "186 C");
  assert.deepEqual(values, ["sanmar", "PC61", "Red", "186 C", "staff_verification"]);
  const conflictSet = sql.split("DO UPDATE SET")[1]!.split("RETURNING")[0]!;
  assert.match(conflictSet, /verified_pantone_code=EXCLUDED\.verified_pantone_code/);
  assert.match(conflictSet, /verified_pantone_source=EXCLUDED\.verified_pantone_source/);
  assert.doesNotMatch(conflictSet, /\b(rgb_|lab_|measurement_method|algorithm_version)/);
});

test("removal keeps the evidence identity row and clears code/source", async () => {
  let values: unknown[] = [];
  const client = {
    async query(_text: string, params: unknown[]) {
      values = params;
      return { rowCount: 1, rows: [{ verified_pantone_code: null, verified_pantone_source: null }] };
    },
  };
  const row = await upsertVerifiedPantone(
    client,
    { vendor: "ss", styleName: "5000", colorName: "Black" },
    { code: null, source: null },
  );
  assert.ok(row);
  assert.deepEqual(values.slice(3), [null, null]);
});

test("an identity absent from the current import is not created", async () => {
  const client = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };
  assert.equal(
    await upsertVerifiedPantone(
      client,
      { vendor: "sanmar", styleName: "missing", colorName: "missing" },
      { code: "1 C", source: "vendor_documentation" },
    ),
    null,
  );
});