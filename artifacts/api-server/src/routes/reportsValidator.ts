import { Router, type IRouter } from "express";

/**
 * Temporary validation UI for the Reports module — lets Tyler run the
 * same reports the legacy Insights app produced and compare numbers,
 * before the real Reports frontend is built. Serves one self-contained
 * HTML page; all data comes from the /api/reports/* JSON endpoints via
 * relative fetches (no base-path assumptions).
 */

const router: IRouter = Router();

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Printavo Hub — Report Validator</title>
<style>
  :root { --mint: #0f9d6e; --ink: #1a1f24; --line: #e3e8ee; --muted: #66717d; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: #f7f9fa; }
  header { background: #fff; border-bottom: 1px solid var(--line); padding: 14px 24px; display: flex; align-items: baseline; gap: 12px; }
  header h1 { font-size: 18px; margin: 0; }
  header .tag { font-size: 12px; color: var(--muted); }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 24px 60px; }
  form { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px 16px; }
  label { font-size: 12px; font-weight: 600; color: var(--muted); display: block; margin-bottom: 4px; }
  input, select { width: 100%; padding: 7px 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 14px; background: #fff; }
  select[multiple] { height: 108px; }
  .excl { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 12px; color: var(--muted); }
  .excl input { width: auto; }
  .actions { grid-column: 1 / -1; display: flex; gap: 10px; align-items: center; }
  button { background: var(--mint); color: #fff; border: 0; border-radius: 6px; padding: 9px 22px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  .hint { font-size: 12px; color: var(--muted); }
  #status { font-size: 13px; color: var(--muted); margin: 14px 2px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 14px 0; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card .k { font-size: 12px; color: var(--muted); }
  .card .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
  section { margin-top: 22px; }
  section h2 { font-size: 15px; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; white-space: normal; }
  th { background: #f2f5f7; font-size: 12px; color: var(--muted); }
  tr:last-child td { border-bottom: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 900px) { form, .cards { grid-template-columns: repeat(2, 1fr); } .grid2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Report Validator</h1>
  <span class="tag">temporary tool — compare against the old Insights app</span>
</header>
<main>
  <form id="f" onsubmit="return false">
    <div>
      <label>Created from</label>
      <input type="date" id="createdStart">
    </div>
    <div>
      <label>Created to</label>
      <input type="date" id="createdEnd">
    </div>
    <div>
      <label>Order type</label>
      <select id="orderType">
        <option value="invoice">Invoices</option>
        <option value="quote">Quotes</option>
        <option value="all">Invoices + quotes</option>
      </select>
    </div>
    <div>
      <label>Search (nickname / customer / #)</label>
      <input type="text" id="search" placeholder="optional">
    </div>
    <div>
      <label>Statuses</label>
      <select id="statuses" multiple></select>
      <div class="excl"><input type="checkbox" id="exclStatuses"><span>exclude selected</span></div>
    </div>
    <div>
      <label>Brands</label>
      <select id="brands" multiple></select>
      <div class="excl"><input type="checkbox" id="exclBrands"><span>exclude selected</span></div>
    </div>
    <div>
      <label>Colors</label>
      <select id="colors" multiple></select>
      <div class="excl"><input type="checkbox" id="exclColors"><span>exclude selected</span></div>
    </div>
    <div>
      <label>Order quantity</label>
      <div style="display:flex;gap:6px">
        <input type="number" id="minQty" placeholder="min" min="0">
        <input type="number" id="maxQty" placeholder="max" min="0">
      </div>
    </div>
    <div class="actions">
      <button id="run">Run report</button>
      <span class="hint">Ctrl/Cmd-click to pick multiple; leave a list empty to include everything. Payments use the same date range (cash basis, by payment date).</span>
    </div>
  </form>

  <div id="status">Loading filter options…</div>
  <div id="out" hidden>
    <div class="cards" id="cards"></div>
    <div class="grid2">
      <section><h2>By status</h2><div id="t-status"></div></section>
      <section><h2>By pricing matrix</h2><div id="t-matrix"></div></section>
      <section><h2>Imprints by tier</h2><div id="t-tier"></div></section>
      <section><h2>By order quantity</h2><div id="t-qty"></div></section>
      <section><h2>By brand</h2><div id="t-brand"></div></section>
      <section><h2>By style number</h2><div id="t-style"></div></section>
      <section><h2>By color</h2><div id="t-color"></div></section>
      <section><h2>Payments (cash basis)</h2><div id="t-pay"></div></section>
    </div>
  </div>
</main>
<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var fmtMoney = function (n) { return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var fmtNum = function (n) { return Number(n).toLocaleString("en-US"); };

  function getJson(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { throw new Error(j.errors ? j.errors.join("; ") : (j.error || ("HTTP " + r.status))); }
        return j;
      });
    });
  }

  function fillSelect(el, values) {
    values.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v; o.textContent = v;
      el.appendChild(o);
    });
  }

  function selected(el) {
    return Array.prototype.slice.call(el.selectedOptions).map(function (o) { return o.value; });
  }

  function buildQuery() {
    var p = [];
    var add = function (k, v) { if (v) { p.push(k + "=" + encodeURIComponent(v)); } };
    add("createdStart", $("createdStart").value);
    add("createdEnd", $("createdEnd").value);
    add("orderType", $("orderType").value);
    add("search", $("search").value.trim());
    add("minQty", $("minQty").value);
    add("maxQty", $("maxQty").value);
    var excludes = [];
    var lists = [["statuses", "exclStatuses"], ["brands", "exclBrands"], ["colors", "exclColors"]];
    lists.forEach(function (pair) {
      var vals = selected($(pair[0]));
      if (vals.length > 0) {
        add(pair[0], vals.join("||"));
        if ($(pair[1]).checked) { excludes.push(pair[0]); }
      }
    });
    if (excludes.length > 0) { add("exclude", excludes.join("||")); }
    return p.join("&");
  }

  function table(rows, into) {
    var html = "<table><tr><th></th><th>Orders</th><th>Qty</th><th>Revenue</th><th>% of revenue</th></tr>";
    rows.forEach(function (r) {
      html += "<tr><td>" + escapeHtml(r.label) + "</td><td>" + fmtNum(r.orders) + "</td><td>" + fmtNum(r.quantity) +
        "</td><td>" + fmtMoney(r.revenue) + "</td><td>" + r.pctOfRevenue + "%</td></tr>";
    });
    html += "</table>";
    $(into).innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function payTables(pay, stats) {
    var html = "<table><tr><th>Type</th><th>Count</th><th>Amount</th></tr>";
    stats.byType.forEach(function (r) {
      html += "<tr><td>" + escapeHtml(r.typename) + "</td><td>" + fmtNum(r.count) + "</td><td>" + fmtMoney(r.amount) + "</td></tr>";
    });
    html += "<tr><td><b>Net collected</b></td><td></td><td><b>" + fmtMoney(stats.net) + "</b></td></tr></table>";
    html += "<div style='height:10px'></div>";
    html += "<table><tr><th>" + (pay.granularity === "weekly" ? "Week of" : "Date") + "</th><th>Payments</th><th>Amount</th></tr>";
    pay.buckets.forEach(function (b) {
      html += "<tr><td>" + escapeHtml(b.bucket) + "</td><td>" + fmtNum(b.count) + "</td><td>" + fmtMoney(b.amount) + "</td></tr>";
    });
    html += "</table>";
    $("t-pay").innerHTML = html;
  }

  function run() {
    var q = buildQuery();
    var start = $("createdStart").value;
    var end = $("createdEnd").value;
    $("run").disabled = true;
    $("status").textContent = "Running…";
    var calls = [
      getJson("orders?limit=1&" + q),
      getJson("status-breakdown?" + q),
      getJson("pricing-matrix-breakdown?" + q),
      getJson("imprints-by-tier?" + q),
      getJson("order-quantity-breakdown?" + q),
      getJson("brand-breakdown?" + q),
      getJson("style-number-breakdown?" + q),
      getJson("color-breakdown?" + q),
    ];
    var payQ = [];
    if (start) { payQ.push("start=" + start); }
    if (end) { payQ.push("end=" + end); }
    calls.push(getJson("payments?" + payQ.join("&")));
    calls.push(getJson("payments/stats?" + payQ.join("&")));
    Promise.all(calls).then(function (r) {
      var s = r[0].stats;
      $("cards").innerHTML =
        "<div class='card'><div class='k'>Orders</div><div class='v'>" + fmtNum(s.orders) + "</div></div>" +
        "<div class='card'><div class='k'>Revenue (order totals)</div><div class='v'>" + fmtMoney(s.revenue) + "</div></div>" +
        "<div class='card'><div class='k'>Quantity (pieces)</div><div class='v'>" + fmtNum(s.quantity) + "</div></div>" +
        "<div class='card'><div class='k'>Avg order value</div><div class='v'>" + fmtMoney(s.avgOrderValue) + "</div></div>";
      table(r[1].rows, "t-status");
      table(r[2].rows, "t-matrix");
      table(r[3].rows, "t-tier");
      table(r[4].rows, "t-qty");
      table(r[5].rows, "t-brand");
      table(r[6].rows.slice(0, 30), "t-style");
      table(r[7].rows.slice(0, 30), "t-color");
      payTables(r[8], r[9]);
      $("out").hidden = false;
      $("status").textContent = "Done. Style and color tables show the top 30 rows. Note: brand/style/color use line-item prices (no tax or shipping); status and quantity use full order totals — same as the old app.";
    }).catch(function (err) {
      $("status").textContent = "Report failed: " + err.message;
    }).finally(function () {
      $("run").disabled = false;
    });
  }

  getJson("filter-options").then(function (opts) {
    fillSelect($("statuses"), opts.statuses);
    fillSelect($("brands"), opts.brands);
    fillSelect($("colors"), opts.colors);
    var now = new Date();
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    var iso = function (d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    };
    $("createdStart").value = iso(first);
    $("createdEnd").value = iso(now);
    $("status").textContent = "Pick a date range and filters, then Run report.";
  }).catch(function (err) {
    $("status").textContent = "Could not load filter options: " + err.message;
  });

  $("run").addEventListener("click", run);
})();
</script>
</body>
</html>`;

router.get("/reports/validator", (_req, res) => {
  res
    .type("html")
    .setHeader("Cache-Control", "no-store")
    .send(PAGE);
});

export default router;
