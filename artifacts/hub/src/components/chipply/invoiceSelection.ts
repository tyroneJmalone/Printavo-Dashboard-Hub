import type { ChipplyCategoryInvoiceResponse } from "@workspace/api-client-react";
import { selectionKey, type CategorySelection } from "./categorySelection.ts";

/** All-or-nothing merge: never silently select only part of an invoice. */
export function mergeInvoiceSelection(existing: CategorySelection[], incoming: CategorySelection[], cap: number) {
  const merged = new Map(existing.map((line) => [selectionKey(line), line]));
  for (const line of incoming) merged.set(selectionKey(line), line);
  if (merged.size > cap) {
    throw new Error(`This invoice would bring the selection to ${merged.size} lines, above the ${cap}-line limit. Nothing was added. Clear other selections or select individual lines in an explicitly smaller batch.`);
  }
  return [...merged.values()];
}

/** Read every mirrored detail page before allowing an invoice-wide selection. */
export async function loadInvoiceMissingLines(
  orderId: string,
  fetchPage: (page: number) => Promise<ChipplyCategoryInvoiceResponse>,
) {
  const first = await fetchPage(1);
  const lines = new Map<string, CategorySelection>();
  const seen = new Set<string>();
  function collect(data: ChipplyCategoryInvoiceResponse, page: number) {
    if (data.invoice.orderId !== orderId || data.invoice.detailSyncState !== "complete" || !data.invoice.detailSyncedAt) {
      throw new Error("Invoice details are not fully mirrored. Nothing was added. Wait for detail sync to complete, refresh, and try again; check Printavo for the complete invoice.");
    }
    if (data.page !== page || data.pageSize !== first.pageSize || data.pageSize < 1 || data.total !== first.total || data.invoice.detailSyncedAt !== first.invoice.detailSyncedAt) {
      throw new Error("Invoice details changed while loading. Nothing was added. Refresh and select the invoice again.");
    }
    for (const line of data.lineItems) {
      if (line.orderId !== orderId || seen.has(line.lineItemId)) {
        throw new Error("Invoice detail pages were inconsistent. Nothing was added. Refresh and try again.");
      }
      seen.add(line.lineItemId);
      if (!line.currentCategoryId) lines.set(line.lineItemId, { orderId, lineItemId: line.lineItemId });
    }
  }
  collect(first, 1);
  for (let page = 2; page <= Math.ceil(first.total / first.pageSize); page++) {
    collect(await fetchPage(page), page);
  }
  if (seen.size !== first.total) {
    throw new Error("Some mirrored product lines are missing. Nothing was added. Refresh after detail sync completes.");
  }
  return [...lines.values()];
}