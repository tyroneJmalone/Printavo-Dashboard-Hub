import QRCode from "qrcode";
import { MINT_LOGO_DATA_URI } from "../purchasing/poLogos";
import { PRINTAVO_SIZE_ENUM } from "@workspace/printavo";
import {
  esc,
  shipToLines,
  type ShippingDocGroup,
  type ShippingDocOrder,
  type ShipToAddress,
} from "./shippingDocs";

/**
 * Print Queue — packing slips (PQ3b, restyled per Tyler 2026-07-23).
 *
 * Pure-local rendering from the sync snapshot: one combined printable HTML
 * document, one packing slip per invoice, page break between orders.
 *
 * The layout intentionally mirrors Printavo's public-invoice template (the
 * same one the team batch-prints workorders from): amber doc-type pill + QR
 * top row, "Invoice #N" header, logo + shop block beside a gray meta box,
 * Customer Billing / Customer Shipping columns, then one size-matrix table
 * per line-item group. Shipping doc = NO prices, NO imprint details.
 */

const SHOP = {
  name: "Mint Printworks",
  addressLines: ["125 Northeastern Boulevard", "Suite 3", "Nashua, New Hampshire 03062"],
  phone: "+16037181100",
  website: "https://www.MintPrintworks.com",
  email: "tyler@mintprintworks.com",
};

/** Enum declaration order = size column order; unknown sizes sort last. */
const SIZE_ORDER = new Map([...PRINTAVO_SIZE_ENUM].map((s, i) => [s, i]));

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  // Printavo's createdAt/dueAt are calendar dates stored at UTC midnight
  // (blob has "2026-06-19", column has 2026-06-19 00:00:00+00). Formatting
  // in shop-local time would shift the day back by one, so render in UTC.
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function addressLines(a: ShipToAddress): string[] {
  const cityLine = [a.city, a.stateIso ?? a.state, a.zipCode]
    .filter(Boolean)
    .join(", ")
    .replace(/, ([^,]*)$/, " $1");
  return [
    a.companyName,
    a.customerName,
    a.address1,
    a.address2,
    cityLine || null,
    a.country && a.country !== "US" ? a.country : null,
  ].filter((l): l is string => Boolean(l && l.trim()));
}

function billingBlock(order: ShippingDocOrder): string {
  const lines: string[] = [];
  if (order.billTo) {
    lines.push(...addressLines(order.billTo).map((l) => esc(l)));
  } else {
    const who = [order.customerCompany, order.contactName].filter(Boolean);
    if (who.length === 0) return `<div class="addr"><b>Customer Billing</b><br>—</div>`;
    lines.push(...who.map((l) => esc(l!)));
  }
  const contact = order.contactEmail
    ? `<div class="addr-contact"><a href="mailto:${esc(order.contactEmail)}">${esc(order.contactEmail)}</a></div>`
    : "";
  return `<div class="addr">
      <b>Customer Billing</b><br>
      ${lines.join("<br>\n      ")}
      ${contact}
    </div>`;
}

function shippingBlock(order: ShippingDocOrder): string {
  const lines = shipToLines(order);
  if (!lines) {
    const who = [order.contactName, order.customerCompany]
      .filter(Boolean)
      .join(" — ");
    return `<div class="addr">
      <b>Customer Shipping</b><br>
      <span class="no-address">No shipping address on file</span>
      ${who ? `<br>${esc(who)}` : ""}
    </div>`;
  }
  return `<div class="addr">
      <b>Customer Shipping</b><br>
      ${lines.join("<br>\n      ")}
    </div>`;
}

/** Union of sizes present in a group, enum-ordered (unknowns last, stable). */
function groupSizeColumns(group: ShippingDocGroup): { key: string; label: string }[] {
  const seen = new Map<string, { label: string; firstIdx: number }>();
  let idx = 0;
  for (const li of group.lineItems) {
    for (const s of li.sizeCounts) {
      if (!seen.has(s.key)) seen.set(s.key, { label: s.label, firstIdx: idx++ });
    }
  }
  return [...seen.entries()]
    .sort((a, b) => {
      const ao = SIZE_ORDER.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const bo = SIZE_ORDER.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      return ao !== bo ? ao - bo : a[1].firstIdx - b[1].firstIdx;
    })
    .map(([key, v]) => ({ key, label: v.label }));
}

function groupTable(group: ShippingDocGroup): string {
  const sizeCols = groupSizeColumns(group);
  const head = `<tr>
        <th class="th-cat">Category</th>
        <th class="th-item">Item #</th>
        <th class="th-color">Color</th>
        <th class="th-desc">Description</th>
        ${sizeCols.map((c) => `<th class="th-size">${esc(c.label)}</th>`).join("\n        ")}
        <th class="th-qty">Qty</th>
      </tr>`;
  const rows = group.lineItems
    .map((li) => {
      const byKey = new Map(li.sizeCounts.map((s) => [s.key, s.count]));
      return `<tr>
        <td>${esc(li.categoryName) || ""}</td>
        <td>${esc(li.itemNumber) || ""}</td>
        <td>${esc(li.color) || ""}</td>
        <td class="td-desc">${esc(li.description) || ""}</td>
        ${sizeCols
          .map((c) => {
            const n = byKey.get(c.key);
            return `<td class="td-size">${n ?? ""}</td>`;
          })
          .join("\n        ")}
        <td class="td-qty">${li.quantity}</td>
      </tr>`;
    })
    .join("\n      ");
  return `<table>
    <thead>
      ${head}
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function metaBox(order: ShippingDocOrder): string {
  const rows: [string, string][] = [];
  const created = fmtDate(order.createdAt);
  const due = fmtDate(order.customerDueAt);
  if (created) rows.push(["Created", esc(created)]);
  if (due) rows.push(["Customer Due Date", esc(due)]);
  if (order.visualPoNumber) rows.push(["PO #", esc(order.visualPoNumber)]);
  if (order.deliveryMethod) rows.push(["Delivery", esc(order.deliveryMethod)]);
  if (rows.length === 0) return "";
  return `<div class="meta-box">
      ${rows
        .map(
          ([k, v]) => `<div class="meta-row"><div class="meta-label">${k}</div><div class="meta-value">${v}</div></div>`,
        )
        .join("\n      ")}
    </div>`;
}

function slipInner(order: ShippingDocOrder, qrSvg: string | null): string {
  const groups = order.groups.filter((g) => g.lineItems.length > 0);
  const tables =
    groups.length > 0
      ? groups.map((g) => groupTable(g)).join("\n  ")
      : `<table><tbody><tr><td class="empty">No line items on this order.</td></tr></tbody></table>`;

  return `<div class="slip">
  <div class="doc-banner-row">
    <div class="doc-banner"><strong>Packing Slip</strong></div>
    ${qrSvg ? `<div class="qr">${qrSvg}</div>` : ""}
  </div>
  <div class="invoice-card">
    <div class="head-row">
      <div>
        <h3 class="inv-num">Invoice #${order.visualId}</h3>
        ${order.nickname ? `<h4 class="inv-nick">${esc(order.nickname)}</h4>` : ""}
      </div>
      <div class="thanks">Thank you for your business. We appreciate you!</div>
    </div>
    <div class="shop-row">
      <div class="shop-cols">
        <div class="logo-wrap">
          <img class="mint-logo" src="${MINT_LOGO_DATA_URI}" alt="${esc(SHOP.name)}" />
        </div>
        <div class="shop-info">
          <p><b>${esc(SHOP.name)}</b></p>
          <p>${SHOP.addressLines.map((l) => esc(l)).join("<br>")}</p>
          <p>${esc(SHOP.phone)}<br>
          <a href="${esc(SHOP.website)}">${esc(SHOP.website)}</a><br>
          <a href="mailto:${esc(SHOP.email)}">${esc(SHOP.email)}</a></p>
        </div>
      </div>
      ${metaBox(order)}
    </div>
    <hr>
    <div class="addr-row">
      ${billingBlock(order)}
      ${shippingBlock(order)}
    </div>
    ${tables}
    <div class="totals-row">
      <div class="totals-box">
        <div class="meta-row"><div class="meta-label">Quantity</div><div class="meta-value">${order.totalQuantity}</div></div>
      </div>
    </div>
  </div>
</div>`;
}

export async function renderCombinedPackingSlipsHtml(
  orders: ShippingDocOrder[],
  nonce: string,
): Promise<string> {
  const total = orders.length;
  const qrSvgs = await Promise.all(
    orders.map((o) =>
      QRCode.toString(`https://www.printavo.com/invoices/${o.printavoId}`, {
        type: "svg",
        margin: 0,
        width: 114,
        errorCorrectionLevel: "M",
      }).catch(() => null),
    ),
  );
  const cards = orders
    .map(
      (o, i) => `<div class="pq-wrapper">
    <div class="pq-controls">Order #${o.visualId} — ${i + 1} of ${total}</div>
    <div class="pq-page">${slipInner(o, qrSvgs[i])}</div>
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
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #333; margin: 0; font-size: 14px; }
  a { color: #337ab7; text-decoration: none; }
  .slip { padding: 24px 28px 36px; }
  .doc-banner-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
  .doc-banner { background: #fcf8e3; border: 1px solid #faebcc; color: #8a6d3b; padding: 10px 16px; border-radius: 4px; font-size: 14px; }
  .qr svg { width: 90px; height: 90px; display: block; }
  .invoice-card { background: #fff; }
  .head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .inv-num { font-size: 24px; font-weight: 600; margin: 0; }
  .inv-nick { font-size: 16px; font-weight: 400; margin: 8px 0 0; }
  .thanks { color: #999; font-size: 13px; text-align: right; padding-top: 4px; }
  .shop-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-top: 26px; }
  .shop-cols { display: flex; align-items: flex-start; gap: 22px; }
  .logo-wrap { width: 170px; flex: none; }
  .mint-logo { max-width: 170px; max-height: 110px; width: auto; height: auto; display: block; }
  .shop-info { font-size: 13px; line-height: 1.5; }
  .shop-info p { margin: 0 0 8px; }
  .meta-box { background: #f5f5f5; padding: 14px 20px; min-width: 300px; font-size: 13px; }
  .meta-row { display: flex; gap: 14px; padding: 4px 0; }
  .meta-label { width: 46%; text-align: right; font-weight: 700; flex: none; }
  .meta-value { text-align: left; }
  hr { border: 0; border-top: 1px solid #eee; margin: 26px 0; }
  .addr-row { display: flex; gap: 24px; margin-bottom: 6px; }
  .addr { width: 44%; font-size: 13px; line-height: 1.6; }
  .addr b { display: inline-block; margin-bottom: 2px; }
  .addr-contact { margin-top: 2px; }
  .no-address { color: #b45309; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 20px; }
  th { text-align: left; font-weight: 700; background: #f5f5f5; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 8px 8px; }
  th.th-cat { width: 11%; }
  th.th-item { width: 9%; }
  th.th-color { width: 11%; }
  th.th-size, td.td-size { width: 34px; text-align: center; padding-left: 4px; padding-right: 4px; }
  th.th-qty, td.td-qty { width: 44px; text-align: center; }
  td { border-bottom: 1px solid #eee; border-left: 1px solid #eee; padding: 9px 8px; vertical-align: top; }
  td:first-child { border-left: 0; }
  td.td-desc p { margin: 0; }
  td.empty { color: #b45309; border-left: 0; }
  .totals-row { display: flex; justify-content: flex-end; margin-top: 18px; }
  .totals-box { background: #f5f5f5; padding: 10px 20px; min-width: 260px; font-size: 13px; }

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
