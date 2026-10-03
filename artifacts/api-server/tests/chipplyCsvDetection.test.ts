import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCsvKind, isDetailedDataExport, parseCsvRows } from "../src/lib/chipply/parseCsv";

test("recognizes detailed exports without treating them as margin reports", () => {
  const headers = parseCsvRows("\uFEFFSales Order,Order Number,Process Name,Item Qty,Item Total,Style,Vendor\n")[0];
  assert.equal(isDetailedDataExport(headers), true);
  assert.equal(detectCsvKind(headers), "unknown");
});

test("preserves existing report recognition and rejects unrelated files", () => {
  for (const [headers, kind] of [
    [["Vendor Name", "Style", "Total Profit"], "margin_report"],
    [["Store Name", "Sale Order", "Chipply Fee"], "sales_report"],
    [["Style", "Vendor"], "unknown"],
  ] as const) {
    assert.equal(isDetailedDataExport([...headers]), false);
    assert.equal(detectCsvKind([...headers]), kind);
  }
});