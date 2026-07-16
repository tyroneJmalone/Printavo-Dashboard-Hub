import { MINT_LOGO_DATA_URI } from "../purchasing/poLogos";
import {
  esc,
  shipToLines,
  type ShippingDocOrder,
} from "./shippingDocs";

/**
 * Print Queue — box labels (PQ3b).
 *
 * Pure-local rendering from the sync snapshot. Default: one label per
 * line-item group (a group ≈ a box in Printavo semantics), minimum one
 * label per order. `perOrder` overrides with a uniform label count for
 * every order. Layout: letter sheet, two 5.5"-tall labels per page —
 * prints fine on a normal letter printer, cut on the dashed line.
 */

export const MAX_LABELS_PER_ORDER = 20;

interface Label {
  order: ShippingDocOrder;
  boxNum: number;
  boxCount: number;
}

function buildLabels(orders: ShippingDocOrder[], perOrder: number | null): Label[] {
  const labels: Label[] = [];
  for (const order of orders) {
    const count = Math.min(
      perOrder ?? Math.max(order.groups.length, 1),
      MAX_LABELS_PER_ORDER,
    );
    for (let i = 1; i <= count; i++) {
      labels.push({ order, boxNum: i, boxCount: count });
    }
  }
  return labels;
}

function labelInner(label: Label): string {
  const { order } = label;
  const lines = shipToLines(order);
  const shipTo = lines
    ? lines.map((l) => `<div>${l}</div>`).join("\n        ")
    : `<div class="no-address">No shipping address on file</div>
        <div>${esc(
          [order.contactName, order.customerCompany].filter(Boolean).join(" — "),
        )}</div>`;
  return `<div class="label">
    <div class="label-top">
      <div class="from">
        <img class="mint-logo" src="${MINT_LOGO_DATA_URI}" alt="Mint Printworks" />
        <div class="from-text">
          <div class="from-label">From</div>
          <div>Mint Printworks</div>
        </div>
      </div>
      <div class="box-count">Box ${label.boxNum} of ${label.boxCount}</div>
    </div>
    <div class="shipto">
      <div class="shipto-label">Ship to</div>
      <div class="shipto-lines">
        ${shipTo}
      </div>
    </div>
    <div class="label-bottom">
      <div class="order-num">Order #${order.visualId}</div>
      <div class="order-info">
        ${order.customerCompany ? `<div>${esc(order.customerCompany)}</div>` : ""}
        ${order.nickname ? `<div class="nick">${esc(order.nickname)}</div>` : ""}
        ${order.visualPoNumber ? `<div>PO # ${esc(order.visualPoNumber)}</div>` : ""}
      </div>
    </div>
  </div>`;
}

export function renderCombinedBoxLabelsHtml(
  orders: ShippingDocOrder[],
  nonce: string,
  perOrder: number | null,
): string {
  const labels = buildLabels(orders, perOrder);
  const sheets: string[] = [];
  for (let i = 0; i < labels.length; i += 2) {
    const pair = labels
      .slice(i, i + 2)
      .map((l) => labelInner(l))
      .join('\n  <div class="cut-line"></div>\n  ');
    sheets.push(`<div class="sheet">
  ${pair}
</div>`);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Box Labels (${labels.length})</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1f24; margin: 0; }
  .label { height: 5in; padding: 34px 44px; display: flex; flex-direction: column; justify-content: space-between; page-break-inside: avoid; }
  .label-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .from { display: flex; align-items: center; gap: 12px; }
  .mint-logo { height: 40px; width: auto; display: block; }
  .from-text { font-size: 13px; font-weight: 600; }
  .from-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #66717d; font-weight: 600; }
  .box-count { font-size: 20px; font-weight: 700; border: 2px solid #1a1f24; border-radius: 6px; padding: 6px 14px; white-space: nowrap; }
  .shipto-label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #66717d; font-weight: 600; margin-bottom: 6px; }
  .shipto-lines { font-size: 26px; font-weight: 700; line-height: 1.3; }
  .shipto-lines .no-address { color: #b45309; font-size: 20px; }
  .label-bottom { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  .order-num { font-size: 24px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .order-info { text-align: right; font-size: 13px; color: #333; max-width: 55%; }
  .order-info .nick { font-weight: 600; }
  .cut-line { border-top: 2px dashed #9ca3af; }

  @media print {
    .pq-header { display: none !important; }
    .sheet { page-break-after: always; }
    .sheet:last-of-type { page-break-after: auto; }
    .cut-line { border-top: 2px dashed #d1d5db; }
  }

  @media screen {
    body { background: #f3f4f6; }
    .pq-header {
      position: sticky; top: 0; z-index: 100;
      background: #1e293b; color: white;
      padding: 12px 24px;
      display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    .pq-header h1 { font-size: 16px; font-weight: 600; margin: 0; color: white; }
    .pq-header p { font-size: 13px; opacity: 0.7; margin: 2px 0 0; }
    .pq-print-btn {
      background: #059669; color: white; border: none;
      padding: 10px 24px; border-radius: 6px; font-size: 14px;
      font-weight: 600; cursor: pointer;
    }
    .pq-print-btn:hover { background: #047857; }
    .sheet { max-width: 850px; margin: 24px auto; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 4px; }
  }
</style>
</head>
<body>
  <div class="pq-header">
    <div>
      <h1>Box Labels</h1>
      <p>${labels.length} label${labels.length === 1 ? "" : "s"} — ${orders.length} order${orders.length === 1 ? "" : "s"}</p>
    </div>
    <button type="button" class="pq-print-btn" id="pq-print-btn">Print All (${labels.length})</button>
  </div>
  ${sheets.join("\n  ")}
  <script nonce="${nonce}">
    document.getElementById('pq-print-btn').addEventListener('click', function () { window.print(); });
  </script>
</body>
</html>`;
}
