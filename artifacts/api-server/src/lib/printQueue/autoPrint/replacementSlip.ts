import type { PoFileDto } from "../../purchasing/poFiles";

export interface ReplacementSlipSnapshot {
  version: 1;
  po: PoFileDto;
  orderId: string;
  nickname: string | null;
}

/** Exact saved PO identities and quantities only; never expand from live invoice lines. */
export function replacementSlipSnapshot(
  po: PoFileDto,
  orders: readonly { printavoId: string; visualId: number | null; nickname: string | null }[],
): ReplacementSlipSnapshot | null {
  const lines = po.lineItems.filter(line => line.visualId === 22787);
  if (!lines.length) return null;
  const ids = new Set(lines.map(line => line.printavoOrderId));
  if (ids.size !== 1 || !lines.every(line => line.printavoOrderId && line.printavoLineItemId)) {
    throw new Error("Replacement slip requires exact saved order and line identities");
  }
  const order = orders.find(row => row.printavoId === lines[0].printavoOrderId && row.visualId === 22787);
  if (!order) throw new Error("Replacement invoice identity cannot be verified");
  if (!po.submittedToVendorAt || !Number.isFinite(Date.parse(po.submittedToVendorAt))) {
    throw new Error("Replacement slip requires a confirmed order date");
  }
  if (lines.some(line => !line.sizes.length || line.sizes.some(size =>
    !Number.isSafeInteger(size.qty) || size.qty < 0) || !line.sizes.some(size => size.qty > 0))) {
    throw new Error("Replacement slip has invalid PO quantities");
  }
  return structuredClone({ version: 1, orderId: order.printavoId, nickname: order.nickname,
    po: { ...po, lineItems: lines } });
}

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const warehouse = (line: PoFileDto["lineItems"][number]) =>
  [line.warehouseName, line.warehouseCode].filter(Boolean).join(" · ") || "Not recorded";

export function renderReplacementSlipHtml(snapshot: ReplacementSlipSnapshot): string {
  const { po, nickname } = snapshot;
  const warehouses = [...new Set(po.lineItems.map(warehouse))];
  const date = new Date(po.submittedToVendorAt!).toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const vendor = ({ sanmar: "SanMar", ss: "S&S Activewear" } as Record<string, string>)[po.vendorName] ?? po.vendorName;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Replacement slip — PO ${escape(po.poNumber)}</title>
<style>
body{font:10pt Arial,sans-serif;color:#111;margin:0}h1{font-size:17pt;margin:0 0 7pt}p{margin:0 0 10pt}
.meta{border-top:1px solid #777;padding-top:10pt;display:grid;grid-template-columns:1fr 1fr;gap:10pt;margin-bottom:14pt}
.label{font-weight:bold;font-size:8pt;display:block;margin-bottom:4pt}
table{border-collapse:collapse;width:100%;table-layout:fixed}th{text-align:left;background:#eee;font-size:9pt;padding:6pt}
td{padding:8pt 6pt;vertical-align:top;overflow-wrap:anywhere}.description{white-space:pre-wrap;overflow-wrap:anywhere;padding:6pt 6pt 13pt;border-bottom:1px solid #999;line-height:1.35}
.line{break-inside:avoid}.line:nth-child(even){background:#f6f6f6}
</style></head><body><h1>Invoice #22787</h1><p>${escape(nickname ?? "Nickname not recorded")}</p>
<div class="meta"><div><span class="label">PO #</span>${escape(po.poNumber)}</div><div><span class="label">Order date</span>${escape(date)}</div>
<div><span class="label">Vendor</span>${escape(vendor || "Not recorded")}</div><div><span class="label">Warehouse</span>${escape(warehouses.length === 1 ? warehouses[0] : "Multiple — shown by line")}</div></div>
${po.lineItems.map(line => `<section class="line"><table><thead><tr><th style="width:27%">Item / Style</th><th style="width:38%">Color</th><th style="width:22%">Size</th><th style="width:13%">Qty</th></tr></thead><tbody>
${line.sizes.filter(size => size.qty > 0).map(size => `<tr><td>${escape(line.styleNumber)}</td><td>${escape(line.color ?? "Not recorded")}</td><td>${escape(size.vendorSize ?? size.size)}</td><td>${size.qty}</td></tr>`).join("")}</tbody></table>
${warehouses.length > 1 ? `<p style="padding:0 6pt"><span class="label">Warehouse</span>${escape(warehouse(line))}</p>` : ""}
<div class="description"><span class="label">Line-item description</span>${escape(line.description ?? "Not recorded")}</div></section>`).join("")}</body></html>`;
}
