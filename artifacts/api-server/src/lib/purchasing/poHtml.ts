import type { PoFileDto, PoFileLineItem } from "./poFiles";

/**
 * Renders a printable PO document from the structured jsonb snapshot.
 * HTML is generated on demand — never stored (edits would go stale).
 * Same endpoint will feed Printavo productionFileCreate in Phase 3.
 */

const VENDOR_LABELS: Record<string, string> = {
  sanmar: "SanMar",
  ss: "S&S Activewear",
  manual: "Manual / Other",
};

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function lineTotal(li: PoFileLineItem): { qty: number; cost: number } {
  let qty = 0;
  let cost = 0;
  for (const s of li.sizes) {
    qty += s.qty;
    cost += s.qty * s.unitCost;
  }
  return { qty, cost };
}

export function renderPoHtml(po: PoFileDto): string {
  const rows = po.lineItems
    .map((li) => {
      const t = lineTotal(li);
      const sizesStr = li.sizes
        .filter((s) => s.qty > 0)
        .map((s) => `${esc(s.size)}&times;${s.qty}`)
        .join(", ");
      const orderRef = li.visualId ? `#${li.visualId}` : "—";
      const colorShown = li.vendorCatalogColor ?? li.color;
      const costRange = (() => {
        const costs = [...new Set(li.sizes.filter((s) => s.qty > 0).map((s) => s.unitCost))];
        if (costs.length === 0) return "—";
        if (costs.length === 1) return money(costs[0]);
        return `${money(Math.min(...costs))}–${money(Math.max(...costs))}`;
      })();
      const warehouse = li.warehouseName ?? li.warehouseCode ?? null;
      return `<tr>
        <td class="mono">${esc(li.styleNumber)}</td>
        <td>${esc(colorShown) || "—"}</td>
        <td class="desc">${esc(li.description) || "—"}${li.source === "manual" ? ' <span class="tag">manual cost</span>' : ""}</td>
        <td class="mono small">${sizesStr || "—"}</td>
        <td class="small">${warehouse ? esc(warehouse) : "—"}</td>
        <td class="mono center">${orderRef}</td>
        <td class="mono right">${t.qty}</td>
        <td class="mono right">${costRange}</td>
        <td class="mono right">${money(t.cost)}</td>
      </tr>`;
    })
    .join("\n");

  const created = new Date(po.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PO ${esc(po.poNumber)} — Mint Print Works</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1f24; margin: 0; padding: 40px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0f9d6e; padding-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .shop { font-size: 13px; color: #66717d; }
  .po-meta { text-align: right; font-size: 13px; }
  .po-meta .num { font-size: 20px; font-weight: 700; font-family: ui-monospace, monospace; }
  .vendor { margin: 18px 0 6px; font-size: 15px; font-weight: 600; }
  .notes { font-size: 13px; color: #444; background: #f6f8f7; border: 1px solid #e3e8ee; border-radius: 6px; padding: 10px 12px; margin: 10px 0 18px; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #66717d; border-bottom: 2px solid #e3e8ee; padding: 8px 8px; }
  td { border-bottom: 1px solid #eef1f4; padding: 8px 8px; vertical-align: top; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .small { font-size: 12px; }
  .desc { max-width: 260px; }
  .right { text-align: right; }
  .center { text-align: center; }
  .tag { font-size: 10px; background: #fff3cd; color: #7a5d00; border-radius: 4px; padding: 1px 5px; }
  .totals { margin-top: 14px; display: flex; justify-content: flex-end; gap: 40px; font-size: 14px; }
  .totals .v { font-weight: 700; font-family: ui-monospace, monospace; }
  .foot { margin-top: 40px; font-size: 11px; color: #8a949e; }
  @media print {
    body { padding: 0; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="head">
    <div>
      <h1>Purchase Order</h1>
      <div class="shop">Mint Print Works</div>
    </div>
    <div class="po-meta">
      <div class="num">PO ${esc(po.poNumber)}</div>
      <div>${esc(created)}</div>
      <div>${esc(VENDOR_LABELS[po.vendorName] ?? po.vendorName)}</div>
    </div>
  </div>
  ${po.notes ? `<div class="notes">${esc(po.notes)}</div>` : ""}
  <table>
    <thead>
      <tr>
        <th>Style</th><th>Color</th><th>Description</th><th>Sizes</th>
        <th>Ship From</th>
        <th style="text-align:center">Order</th>
        <th style="text-align:right">Qty</th>
        <th style="text-align:right">Unit Cost</th>
        <th style="text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <div class="totals">
    <div>Total pieces: <span class="v">${po.totalQuantity}</span></div>
    <div>Total cost: <span class="v">${money(po.totalCost)}</span></div>
  </div>
  <div class="foot">Generated by Printavo Hub &middot; ${esc(new Date().toISOString())}</div>
  <script class="no-print">if (new URLSearchParams(location.search).get("print") === "1") window.print();</script>
</body>
</html>`;
}
