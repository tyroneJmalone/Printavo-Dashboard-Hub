import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessComparisons } from "./ProcessComparison";
import type { ChipplyProcessComparison } from "@workspace/api-client-react";

test("read-only process panel renders normalized counts, links and provisional warnings", () => {
  const comparisons: ChipplyProcessComparison[] = [{
    processKey: "front", processNames: ["PRINT: Front"], state: "ambiguous",
    candidates: [{
      invoiceId: "internal", visualId: 22251, detailSyncedAt: null, sourceUpdatedAt: null,
      state: "incomplete", issues: ["Line 1: size counts do not sum to line quantity 2."], oneSizeNotes: [],
      rows: [{ style: "g500", color: "navy", size: "m", expected: 2, actual: 1, delta: -1, result: "different" }],
    }],
  }];
  const html = renderToStaticMarkup(<ProcessComparisons comparisons={comparisons} />);
  for (const text of ["split invoices unsupported", "does not combine invoices", "provisional", "https://www.printavo.com/invoices/22251", "g500", "navy", "Chipply", "Printavo", "-1", "size counts do not sum"])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes("<button"), "Diagnostic panel must not introduce write controls");
  assert.ok(!html.includes("/invoices/internal"), "Never link an internal ID as the visual invoice number");
});

test("missing candidates are not represented as confirmed shortages", () => {
  const html = renderToStaticMarkup(<ProcessComparisons comparisons={[{ processKey: "front", processNames: ["PRINT: Front"], state: "unmatched", candidates: [] }]} />);
  assert.ok(html.includes("not a confirmed garment shortage"));
});
