// Offline integration: exercises the real router/Python boundary, never Printavo
// or a printer. The isolated Express app intentionally omits production auth.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import express from "express";

const root = path.resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(path.join(tmpdir(), "sorter-parity-"));
const bundle = path.join(import.meta.dirname, ".sorter-test.cjs");
let server;
try {
  const fixture = spawnSync("python3", ["-c", `
import sys
from pathlib import Path
sys.path.insert(0, "artifacts/api-server/python")
from test_single_line_priority import make_fixture
from slip_consolidation import text_overlay
from pypdf import PdfWriter
root = Path(sys.argv[1])
make_fixture(root / "slips.pdf")
labels = PdfWriter()
for order in ["101", "102", "103", "104"]:
    labels.add_page(text_overlay(612, 792, [(18,30,10,f"SHIP NAME{order} FIRST"), (18,45,10,"TO:"), (18,60,10,"123 Main St")]))
labels.write(root / "labels.pdf")
`, temp], { cwd: root, encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  writeFileSync(path.join(temp, "sequence.csv"), "Order Number\n102\n104\n101\n103\n");
  writeFileSync(path.join(temp, "store.csv"), "Dealer Name,Order Number,Keep,Tax Total\nDealer,00123,00456,1.50\n");
  await build({
    entryPoints: [path.join(import.meta.dirname, "src/routes/sorter.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["express", "multer"],
  });
  const router = createRequire(import.meta.url)(bundle).default;
  const app = express();
  app.use((req, _res, next) => {
    req.log = { info() {}, error() {} };
    next();
  });
  app.use("/api", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/sorter`;
  const file = (name) => new Blob([readFileSync(path.join(temp, name))]);
  const form = (preset, extra = {}) => {
    const data = new FormData();
    data.set("preset", preset);
    if (!["combine_labels", "parse_store_export"].includes(preset)) data.set("packing_slips", file("slips.pdf"), "slips.pdf");
    if (["combine_labels", "sort_labels", "sort_both", "match_labels", "spreadsheet_sequence"].includes(preset)) data.set("labels", file("labels.pdf"), "labels.pdf");
    if (preset === "custom_sort") data.set("sort_fields", '["style","size","last_name"]');
    if (preset === "spreadsheet_sequence") {
      data.set("spreadsheet", file("sequence.csv"), "sequence.csv");
      data.set("spreadsheet_mapping", '{"header_row":1,"order_number_column":"Order Number"}');
    }
    if (preset === "parse_store_export") data.set("store_export", file("store.csv"), "store.csv");
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    return data;
  };
  const inspect = new FormData();
  inspect.set("spreadsheet", file("sequence.csv"), "sequence.csv");
  const preview = await fetch(`${base}/spreadsheet/inspect`, { method: "POST", body: inspect });
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).sheets[0].rows[0], ["Order Number"]);
  for (const preset of [
    "combine_labels", "sort_slips", "sort_slips_name", "sort_slips_custom",
    "sort_slips_custom_first", "sort_labels", "sort_both", "match_labels",
    "custom_sort", "required_field", "split_required_field", "spreadsheet_sequence", "parse_store_export",
  ]) {
    const priority = !["combine_labels", "match_labels", "parse_store_export"].includes(preset);
    const preferred = ["sort_slips", "sort_slips_name", "sort_slips_custom", "sort_both", "sort_labels", "custom_sort"].includes(preset);
    const response = await fetch(`${base}/process`, { method: "POST", body: form(preset, {
      single_line_item_first: String(priority),
      ...(preferred ? { preferred_style: "5000", preferred_color: "Royal" } : {}),
    }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(Array.isArray(result.warnings));
    assert.equal(result.outputs.at(-1).key, "zip");
    assert.equal(result.outputs.some(o => o.key === "preferred_product_report"), preferred);
    for (const output of result.outputs) {
      const download = await fetch(`${base}/jobs/${result.jobId}/files/${output.key}`);
      assert.equal(download.status, 200, `${preset}: ${output.key}`);
      assert.ok(download.headers.get("content-disposition").includes(output.filename));
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.ok(bytes.length > 0);
      if (output.mime === "application/pdf") assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
      if (output.key === "parsed_store_export") assert.equal(bytes.toString(), "Order Number,Keep\n00123,00456\n");
      if (output.key === "preferred_product_report") {
        assert.match(output.label, /preferred-product selection report/);
        assert.match(bytes.toString(), /order_number,preferred_style,preferred_color,selection,source_page,product_row,style,color,size/);
        assert.match(bytes.toString(), /5000,Royal/);
      }
    }
    // Remove only synthetic test outputs created by this harness.
    rmSync(`/tmp/mint-jobs/${result.jobId}`, { recursive: true, force: true });
    console.log(`PASS ${preset}: upload, process, warnings, ZIP and downloads`);
  }
  for (const [preset, extra] of [
    ["custom_sort", { sort_fields: "{}" }],
    ["custom_sort", { sort_fields: '["unknown"]' }],
    ["spreadsheet_sequence", { spreadsheet_mapping: "null" }],
    ["spreadsheet_sequence", { spreadsheet_mapping: '{"header_row":0}' }],
    ["match_labels", { single_line_item_first: "true" }],
    ["sort_slips", { single_line_item_first: "yes" }],
    ["sort_slips", { preferred_color: "Royal" }],
    ["sort_slips", { preferred_style: "x".repeat(101) }],
    ["sort_slips", { preferred_style: "5000", preferred_color: "x".repeat(101) }],
    ["match_labels", { preferred_style: "5000" }],
    ["required_field", { preferred_style: "5000" }],
    ["spreadsheet_sequence", { preferred_style: "5000" }],
    ["parse_store_export", { remove_column_indexes: "[-1]" }],
    ["not_a_preset", {}],
  ]) {
    const response = await fetch(`${base}/process`, { method: "POST", body: form(preset, extra) });
    assert.equal(response.status, 400, `${preset}: ${await response.text()}`);
  }
  assert.equal((await fetch(`${base}/jobs/missing/files/zip`)).status, 404);
  console.log("PASS invalid inputs and missing downloads");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(bundle, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
