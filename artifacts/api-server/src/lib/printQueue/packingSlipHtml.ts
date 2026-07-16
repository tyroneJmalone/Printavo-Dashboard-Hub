import { MINT_LOGO_DATA_URI } from "../purchasing/poLogos";
import {
  esc,
  shipToLines,
  type ShippingDocOrder,
} from "./shippingDocs";

/**
 * Print Queue — packing slips (PQ3b).
 *
 * Pure-local rendering from the sync snapshot: one combined printable HTML
 * document, one packing slip per invoice, page break between orders.
 * Shipping doc = NO prices, NO imprint/production details.
 */

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

function shipToBlock(order: ShippingDocOrder): string {
  const lines = shipToLines(order);
  if (!lines) {
    const who = [order.contactName, order.customerCompany]
      .filter(Boolean)
      .join(" — ");
    return `<div class="shipto missing">
      <div class="shipto-label">Ship to</div>
      <div class="no-address">No shipping address on file</div>
      ${who ? `<div>${esc(who)}</div>` : ""}
    </div>`;
  }
  return `<div class="shipto">
    <div class="shipto-label">Ship to</div>
    ${lines.map((l) => `<div>${l}</div>`).join("\n    ")}
  </div>`;
}

function itemsTable(order: ShippingDocOrder): string {
  const rows: string[] = [];
  const multiGroup = order.groups.length > 1;
  order.groups.forEach((group, gi) => {
    if (multiGroup) {
      rows.push(
        `<tr class="group-row"><td colspan="5">Group ${gi + 1}</td></tr>`,
      );
    }
    for (const li of group.lineItems) {
      rows.push(`<tr>
        <td class="mono">${esc(li.itemNumber) || "—"}</td>
        <td>${esc(li.color) || "—"}</td>
        <td class="desc">${esc(li.description) || "—"}</td>
        <td class="mono small">${esc(li.sizeBreakdown.join(", ")) || "—"}</td>
        <td class="mono right">${li.quantity}</td>
      </tr>`);
    }
  });
  if (rows.length === 0) {
    rows.push(
      `<tr><td colspan="5" class="empty">No line items on this order.</td></tr>`,
    );
  }
  return `<table>
    <thead>
      <tr>
        <th style="width:110px">Style</th>
        <th style="width:120px">Color</th>
        <th>Description</th>
        <th style="width:210px">Sizes</th>
        <th style="width:50px;text-align:right">Qty</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>`;
}

function slipInner(order: ShippingDocOrder): string {
  const due = fmtDate(order.customerDueAt);
  const metaRows = [
    order.nickname ? `<div class="nick">${esc(order.nickname)}</div>` : "",
    `<div><span class="k">Customer:</span> ${esc(order.customerCompany ?? order.contactName) || "—"}</div>`,
    order.contactName && order.customerCompany
      ? `<div><span class="k">Contact:</span> ${esc(order.contactName)}</div>`
      : "",
    due ? `<div><span class="k">Due:</span> ${esc(due)}</div>` : "",
    order.visualPoNumber
      ? `<div><span class="k">PO #:</span> ${esc(order.visualPoNumber)}</div>`
      : "",
    order.deliveryMethod
      ? `<div><span class="k">Delivery:</span> ${esc(order.deliveryMethod)}</div>`
      : "",
  ]
    .filter(Boolean)
    .join("\n      ");

  return `<div class="slip">
  <div class="head">
    <div class="brand">
      <img class="mint-logo" src="${MINT_LOGO_DATA_URI}" alt="Mint Printworks" />
      <div>
        <h1>Packing Slip</h1>
        <div class="shop">Mint Printworks</div>
      </div>
    </div>
    <div class="order-meta">
      <div class="num">Order #${order.visualId}</div>
      ${metaRows}
    </div>
  </div>
  ${shipToBlock(order)}
  ${itemsTable(order)}
  <div class="totals">Total pieces: <span class="v">${order.totalQuantity}</span></div>
</div>`;
}

export function renderCombinedPackingSlipsHtml(
  orders: ShippingDocOrder[],
  nonce: string,
): string {
  const total = orders.length;
  const cards = orders
    .map(
      (o, i) => `<div class="pq-wrapper">
    <div class="pq-controls">Order #${o.visualId} — ${i + 1} of ${total}</div>
    <div class="pq-page">${slipInner(o)}</div>
  </div>${i < total - 1 ? `\n  <div class="pq-divider">&#8213; page break &#8213;</div>` : ""}`,
    )
    .join("\n  ");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Packing Slips (${total})</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1f24; margin: 0; }
  .slip { padding: 36px 40px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0f9d6e; padding-bottom: 14px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .mint-logo { height: 54px; width: auto; display: block; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .shop { font-size: 13px; color: #66717d; }
  .order-meta { text-align: right; font-size: 13px; color: #333; }
  .order-meta .num { font-size: 20px; font-weight: 700; font-family: ui-monospace, monospace; margin-bottom: 2px; }
  .order-meta .nick { font-weight: 600; margin-bottom: 4px; }
  .order-meta .k { color: #66717d; }
  .shipto { margin: 18px 0 6px; font-size: 14px; line-height: 1.45; border: 1px solid #e3e8ee; border-radius: 6px; padding: 12px 14px; display: inline-block; min-width: 280px; }
  .shipto-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #66717d; margin-bottom: 4px; font-weight: 600; }
  .shipto.missing .no-address { color: #b45309; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 14px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #66717d; border-bottom: 2px solid #e3e8ee; padding: 8px 8px; }
  td { border-bottom: 1px solid #eef1f4; padding: 8px 8px; vertical-align: top; }
  td.empty { color: #b45309; }
  .group-row td { background: #f6f8f7; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #66717d; padding: 5px 8px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .small { font-size: 12px; }
  .desc { max-width: 260px; }
  .right { text-align: right; }
  .totals { margin-top: 14px; text-align: right; font-size: 14px; }
  .totals .v { font-weight: 700; font-family: ui-monospace, monospace; }

  @media print {
    .pq-header, .pq-controls, .pq-divider { display: none !important; }
    .pq-wrapper { page-break-after: always; }
    .pq-wrapper:last-of-type { page-break-after: auto; }
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
    .pq-wrapper { max-width: 900px; margin: 24px auto; }
    .pq-page { background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 0 0 4px 4px; overflow: hidden; }
    .pq-controls {
      background: #1e293b; border-radius: 4px 4px 0 0;
      padding: 8px 14px; color: #94a3b8;
      font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .pq-divider { max-width: 900px; margin: 0 auto; padding: 6px 0; text-align: center; font-size: 11px; color: #9ca3af; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
  }
</style>
</head>
<body>
  <div class="pq-header">
    <div>
      <h1>Packing Slips</h1>
      <p>${total} order${total === 1 ? "" : "s"}</p>
    </div>
    <button type="button" class="pq-print-btn" id="pq-print-btn">Print All (${total})</button>
  </div>
  ${cards}
  <script nonce="${nonce}">
    document.getElementById('pq-print-btn').addEventListener('click', function () { window.print(); });
  </script>
</body>
</html>`;
}
