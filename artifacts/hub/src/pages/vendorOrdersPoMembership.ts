export interface QueueLineIdentity {
  id: string;
}

export interface QueueOrderIdentity {
  orderId: string;
  lineItems: QueueLineIdentity[];
}

export interface PurchaseOrderLineIdentity {
  printavoLineItemId: string | null;
  printavoOrderId: string | null;
}

export interface PurchaseOrderProjection {
  id: string;
  poNumber: string;
  lineItems: PurchaseOrderLineIdentity[];
  /** Forward-compatible lifecycle fields for read projections that expose them. */
  lifecycle?: string | null;
  status?: string | null;
  deletedAt?: string | null;
}

const TERMINAL_LIFECYCLES = new Set(["closed", "deleted", "cancelled", "canceled"]);

/**
 * A submitted or locked PO is still open. Only an explicit terminal lifecycle
 * removes it; physically deleted POs are naturally absent from the list API.
 */
export function isOpenPurchaseOrder(po: PurchaseOrderProjection): boolean {
  if (po.deletedAt) return false;
  const lifecycle = (po.lifecycle ?? po.status ?? "").trim().toLowerCase();
  return !TERMINAL_LIFECYCLES.has(lifecycle);
}

export function stableLineIdentity(orderId: string, lineItemId: string): string {
  // Length-prefixing avoids delimiter collisions while requiring both stable IDs.
  return `${orderId.length}:${orderId}${lineItemId.length}:${lineItemId}`;
}

/** Build queue membership once for the whole page (never one request per row). */
export function buildOpenPoMembership(
  purchaseOrders: PurchaseOrderProjection[],
): Map<string, string[]> {
  const labelsByLine = new Map<string, Set<string>>();

  for (const po of purchaseOrders) {
    if (!isOpenPurchaseOrder(po)) continue;
    for (const line of po.lineItems) {
      if (!line.printavoOrderId || !line.printavoLineItemId) continue;
      const key = stableLineIdentity(line.printavoOrderId, line.printavoLineItemId);
      const labels = labelsByLine.get(key) ?? new Set<string>();
      labels.add(po.poNumber);
      labelsByLine.set(key, labels);
    }
  }

  return new Map(
    [...labelsByLine].map(([key, labels]) => [
      key,
      [...labels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    ]),
  );
}