import test from "node:test";
import assert from "node:assert/strict";
import type { ChipplyCategoryInvoiceResponse } from "@workspace/api-client-react";
import { loadInvoiceMissingLines, mergeInvoiceSelection } from "./invoiceSelection.ts";

function page(number: number, total = 30): ChipplyCategoryInvoiceResponse {
  return {
    invoice: {
      orderId: "invoice", visualId: 123, nickname: "Test invoice", statusName: "MERCH PRINT",
      statusId: "status", invoiceAt: null, detailSyncState: "complete",
      detailSyncedAt: "2026-01-01T00:00:00Z", lineItemCount: total,
      missingCategoryCount: total, quantity: total, recommendation: { category: null, message: "" },
    },
    lineItems: Array.from({ length: Math.max(0, Math.min(25, total - (number - 1) * 25)) }, (_, index) => ({
      orderId: "invoice", lineItemId: String((number - 1) * 25 + index),
      itemNumber: null, description: null, color: null, brand: null, quantity: 1,
      currentCategoryId: null, currentCategoryName: null,
    })),
    categories: [], recommendation: { category: null, message: "" },
    total, page: number, pageSize: 25, coverage: "Mirror", selectionCap: 100,
  };
}

test("invoice action loads all pages and selects only missing categories", async () => {
  const calls: number[] = [];
  const result = await loadInvoiceMissingLines("invoice", async (number) => {
    calls.push(number);
    const response = page(number);
    if (number === 1) response.lineItems[0].currentCategoryId = "existing";
    return response;
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.length, 29);
  assert.ok(result.some((line) => line.lineItemId === "29"));
  assert.ok(!result.some((line) => line.lineItemId === "0"));
});

test("cap merge is atomic and deduplicates existing selections", () => {
  const old = [{ orderId: "invoice", lineItemId: "0" }];
  assert.equal(mergeInvoiceSelection(old, old, 1).length, 1);
  assert.throws(() => mergeInvoiceSelection(old, [{ orderId: "invoice", lineItemId: "1" }], 1), /Nothing was added/);
  assert.deepEqual(old, [{ orderId: "invoice", lineItemId: "0" }]);
  const oversized = Array.from({ length: 101 }, (_, index) => ({ orderId: "invoice", lineItemId: String(index) }));
  assert.throws(() => mergeInvoiceSelection([], oversized, 100), /101 lines.*100-line limit/);
});

test("rejects incomplete mirror, page errors, and missing product lines", async () => {
  await assert.rejects(loadInvoiceMissingLines("invoice", async () => {
    const response = page(1);
    response.invoice.detailSyncState = "incomplete";
    return response;
  }), /not fully mirrored/);
  await assert.rejects(loadInvoiceMissingLines("invoice", async (number) => {
    if (number === 2) throw new Error("Detail request failed");
    return page(number);
  }), /Detail request failed/);
  await assert.rejects(loadInvoiceMissingLines("invoice", async (number) => {
    const response = page(number);
    response.lineItems.pop();
    return response;
  }), /product lines are missing/);
});

test("rejects changing snapshots instead of silently selecting a partial invoice", async () => {
  await assert.rejects(loadInvoiceMissingLines("invoice", async (number) => {
    const response = page(number);
    if (number === 2) response.invoice.detailSyncedAt = "2026-01-02T00:00:00Z";
    return response;
  }), /changed while loading/);
});