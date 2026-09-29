import assert from "node:assert/strict";
import test from "node:test";
import { hubPoOrdersFromOutcomes } from "../src/lib/printQueue/autoPrint/candidatePlanning";
import { checkPrintSafety } from "../src/lib/printQueue/autoPrint/printSafety";
import { runHubPoBatch } from "../src/lib/printQueue/autoPrint/hubPoBatch";
import type { PoFileDto } from "../src/lib/purchasing/poFiles";

test("engine PO boundary excludes failed/unknown/pending and prints a converted quote snapshot only with provenance", async () => {
  const candidate = { orderId: "invoice", visualId: 100 };
  const conversions = [{ entityType: "order", eventType: "converted", entityId: "invoice", visualId: 100,
    oldValue: { printavoId: "quote", orderType: "quote", customerId: "customer" },
    newValue: { printavoId: "invoice", orderType: "invoice", customerId: "customer" } }];
  const outcomes = [
    { candidate, outcome: "printed" },
    ...["failed", "submission_unknown", "pending", "dry_run"].map((outcome) => ({
      candidate: { orderId: outcome, visualId: 100 }, outcome,
    })),
  ];
  const successful = hubPoOrdersFromOutcomes(outcomes, conversions);
  assert.deepEqual(successful, [{ ...candidate, verifiedSnapshotOrderIds: ["quote"] }]);
  const po: PoFileDto = {
    id: "saved", poNumber: "PO-SAVED", vendorName: "manual", notes: null, totalQuantity: 1, totalCost: 1,
    lineItems: [{ printavoOrderId: "quote", printavoLineItemId: null, visualId: 100,
      styleNumber: "saved", color: null, vendorCatalogColor: null, description: null, brand: null, source: "manual",
      sizes: [{ size: "M", qty: 1, unitCost: 1, sku: null, inventoryKey: null, sizeIndex: null }] }],
    pushedToPrintavoAt: null, submittedToVendorAt: null, vendorOrderNumber: null, locked: false,
    lockReason: null, pushState: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  let sends = 0;
  let reserves = 0;
  const deps = {
    loadRelevantPos: async () => [po],
    reserve: async () => { reserves++; return "reservation"; },
    updateJob: async () => {},
    submit: async () => { sends++; return 123; },
  };
  const input = { runId: "run", successfullyPrintedOrders: successful, printerId: "1",
    printerName: "offline", dryRun: false, renderPdf: async () => Buffer.from("offline") };
  assert.equal((await runHubPoBatch(input, deps)).printed, 1);
  assert.equal(sends, 1);
  await runHubPoBatch({ ...input, successfullyPrintedOrders: hubPoOrdersFromOutcomes(outcomes, []) }, deps);
  await runHubPoBatch({ ...input, successfullyPrintedOrders: hubPoOrdersFromOutcomes(outcomes.slice(1), conversions) }, deps);
  assert.equal(sends, 1);
  assert.equal(reserves, 1);
});

test("engine live source fence rejects moved, missing and wrong-identity observations before submission/advance", () => {
  const expected = { orderId: "invoice", visualId: 100, sourceStatusId: "ordered" };
  const current = { orderId: "invoice", visualId: 100, statusId: "ordered", statusName: "Ordered" };
  assert.equal(checkPrintSafety({ dryRun: false, observedStatus: current, expected }).allowed, true);
  for (const observedStatus of [null, { ...current, statusId: "processing" },
    { ...current, orderId: "other" }, { ...current, visualId: 101 }]) {
    assert.equal(checkPrintSafety({ dryRun: false, observedStatus, expected }).allowed, false);
  }
  assert.equal(checkPrintSafety({ dryRun: true, observedStatus: current, expected }).allowed, false);
});