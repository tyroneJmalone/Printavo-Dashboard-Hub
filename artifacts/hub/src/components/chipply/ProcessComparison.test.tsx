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
  for (const text of ["explicit review required", "does not automatically combine invoices", "provisional", "https://www.printavo.com/invoices/22251", "g500", "navy", "Chipply", "Printavo", "-1", "size counts do not sum"])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes("<button"), "Diagnostic panel must not introduce write controls");
  assert.ok(!html.includes("/invoices/internal"), "Never link an internal ID as the visual invoice number");
});

test("missing candidates are not represented as confirmed shortages", () => {
  const html = renderToStaticMarkup(<ProcessComparisons comparisons={[{ processKey: "front", processNames: ["PRINT: Front"], state: "unmatched", candidates: [] }]} />);
  assert.ok(html.includes("not a confirmed garment shortage"));
});

test("saved split reviews expose stale state, review controls and disabled approval until preview", () => {
  const html = renderToStaticMarkup(<ProcessComparisons comparisons={[{
    processKey: "front", processNames: ["PRINT: Front"], state: "ambiguous", candidates: [],
    splitEvidence: "changed", splitRevision: "review",
    splitReview: { id: "review", invoiceIds: ["a", "b"], action: "approve", reason: "Reviewed intentional split",
      actor: "fixture reviewer", createdAt: "2026-01-01", state: "stale" },
  }]} splitContext={{ snapshotId: "snapshot", submit: async () => { throw new Error("Must not submit during render"); } }} />);
  for (const text of ["Split review: stale", "Attribution is withheld", "Review an intentional invoice split", "Revoke split review", "never changes Printavo", "Approve reviewed split in Hub"]) assert.ok(html.includes(text), text);
  assert.match(html, /disabled=""[^>]*>Approve reviewed split in Hub/);
});
