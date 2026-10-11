import type { PoFileLineItem } from "../../purchasing/poFiles";
import type { AdditionSlipSnapshot } from "./replacementSlip";

export interface MakeupLine {
  id: string;
  groupId: string;
  itemNumber: string | null;
  color: string | null;
  description: string | null;
  sizes: { size: string; count: number }[] | null;
  poLineItem?: { purchaseOrder?: {
    id: string; visualPoId?: string | null;
    vendor?: { name?: string | null; company?: string | null } | null;
  } | null } | null;
}
export interface MakeupObservation {
  orderId: string;
  nickname: string | null;
  observedAt: string;
  lines: MakeupLine[];
}
export interface MakeupBaseline { orderId: string; seenLineIds: string[]; observedAt: string }
export interface HubLineReference {
  poNumber: string; vendorName: string; submittedToVendorAt: string;
  line: PoFileLineItem;
}

/** Identity-based, cumulative baseline: editing, moving, or assigning a PO never reprints a line. */
export function planMakeupAdditions(
  observation: MakeupObservation, baseline: MakeupBaseline | null, hub: HubLineReference[] = [],
): { baseline: MakeupBaseline; slips: AdditionSlipSnapshot[] } {
  if (baseline && baseline.orderId !== observation.orderId) throw new Error("Makeups invoice identity changed; review its baseline");
  if (baseline && Date.parse(observation.observedAt) <= Date.parse(baseline.observedAt)) {
    return { baseline, slips: [] };
  }
  const seen = new Set(baseline?.seenLineIds ?? observation.lines.map(l => l.id));
  const added = observation.lines.filter(l => !seen.has(l.id));
  const groups = new Map<string, AdditionSlipSnapshot>();
  for (const line of added) {
    if (!line.id || !line.groupId || line.sizes?.some(s => !Number.isSafeInteger(s.count) || s.count < 0)) {
      throw new Error("Invalid Makeups line snapshot; baseline unchanged");
    }
    const assigned = line.poLineItem?.purchaseOrder;
    const matches = hub.filter(h => h.line.printavoOrderId === observation.orderId && h.line.printavoLineItemId === line.id &&
      (h.line.styleNumber ?? "").trim().toLowerCase() === (line.itemNumber ?? "").trim().toLowerCase() &&
      (h.line.color ?? "").trim().toLowerCase() === (line.color ?? "").trim().toLowerCase() &&
      (!assigned?.visualPoId || h.poNumber === assigned.visualPoId));
    // Multiple Hub POs for one line are ambiguous: prefer the explicit Printavo link,
    // otherwise show no assignment rather than selecting a historical PO.
    const reference = matches.length === 1 ? matches[0] : undefined;
    const poNumber = assigned?.visualPoId || reference?.poNumber || "PO not assigned";
    const vendorName = assigned?.vendor?.company || assigned?.vendor?.name || reference?.vendorName || "Not recorded";
    const key = assigned?.id ? `printavo:${assigned.id}` : reference ? `hub:${reference.vendorName}:${reference.poNumber}` : "unassigned";
    let slip = groups.get(key);
    if (!slip) {
      slip = { version: 2, orderId: observation.orderId, nickname: observation.nickname, observedAt: observation.observedAt,
        po: { poNumber, vendorName, submittedToVendorAt: reference?.submittedToVendorAt ?? null, lineItems: [] } };
      groups.set(key, slip);
    }
    slip.po.lineItems.push({
      printavoLineItemId: line.id, printavoOrderId: observation.orderId, visualId: 22787,
      styleNumber: line.itemNumber ?? "", color: line.color, description: line.description,
      vendorCatalogColor: null, brand: null, source: "manual",
      warehouseCode: reference?.line.warehouseCode, warehouseName: reference?.line.warehouseName,
      sizes: (line.sizes ?? []).map(s => ({ size: s.size, qty: s.count, unitCost: 0,
        sku: null, inventoryKey: null, sizeIndex: null })),
    });
  }
  for (const line of observation.lines) seen.add(line.id);
  return { baseline: { orderId: observation.orderId, seenLineIds: [...seen], observedAt: observation.observedAt },
    slips: [...groups.values()] };
}
