import type { Logger } from "pino";
import { db, pvOrdersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { REPRINT_BANNER_HTML, WORKORDER_PRESENTATION_CSS } from "./workorderPresentation";

/**
 * Print Queue — combined workorder HTML (PQ1).
 *
 * Printavo workorder pages are PUBLIC (random-hash URLs, no auth), so the
 * server can fetch them directly — this does NOT go through the throttled
 * GraphQL gateway (different host, no rate limit).
 *
 * SSRF guard: order ids come from the client, but URLs are ALWAYS resolved
 * from pv_orders server-side and must be https on a printavo.com host.
 *
 * Fetch strategy (architect-approved): concurrency 5, 8s per-page timeout,
 * failed pages become inline error blocks so one bad page never sinks the
 * whole batch. Kept in a lib (not the route) so PQ3 auto-print can reuse
 * per-order fragments for PDF generation.
 */

const MAX_ORDERS = 50;
const CONCURRENCY = 5;
const PAGE_TIMEOUT_MS = 8_000;

export { MAX_ORDERS };

interface OrderRef {
  printavoId: string;
  visualId: number;
  url: string | null;
}

export interface WorkorderFragment {
  printavoId: string;
  visualId: number;
  /** Inner <body> HTML of the fetched page, or null on failure. */
  bodyHtml: string | null;
  /** Inner <head> HTML (first successful page's head is used for the combined doc). */
  headHtml: string | null;
  /** Attributes of the original <body> tag (class names carry print styles). */
  bodyAttrs: string;
  /** Origin for the <base> tag. */
  origin: string | null;
  error: string | null;
}

export function isAllowedWorkorderUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return u.hostname === "printavo.com" || u.hostname.endsWith(".printavo.com");
  } catch {
    return false;
  }
}

function extract(re: RegExp, html: string): string | null {
  const m = re.exec(html);
  return m ? m[1] : null;
}

async function fetchOne(ref: OrderRef, log: Logger): Promise<WorkorderFragment> {
  const fail = (error: string): WorkorderFragment => ({
    printavoId: ref.printavoId,
    visualId: ref.visualId,
    bodyHtml: null,
    headHtml: null,
    bodyAttrs: "",
    origin: null,
    error,
  });

  if (!ref.url) return fail("No workorder URL on this order");
  if (!isAllowedWorkorderUrl(ref.url)) return fail("Workorder URL is not a Printavo page");

  try {
    const resp = await fetch(ref.url, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      redirect: "follow",
    });
    // Re-validate after redirects — never ingest a page that left printavo.com.
    if (resp.url && !isAllowedWorkorderUrl(resp.url)) {
      return fail("Workorder URL redirected off Printavo");
    }
    if (!resp.ok) return fail(`Printavo returned ${resp.status}`);
    const html = await resp.text();
    const bodyHtml = extract(/<body[^>]*>([\s\S]*)<\/body>/i, html);
    if (!bodyHtml) return fail("Page had no readable content");
    const headHtml = extract(/<head[^>]*>([\s\S]*)<\/head>/i, html);
    const bodyAttrs = extract(/<body([^>]*)>/i, html) ?? "";
    return {
      printavoId: ref.printavoId,
      visualId: ref.visualId,
      bodyHtml,
      headHtml,
      bodyAttrs,
      origin: new URL(ref.url).origin,
      error: null,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    log.warn({ err, orderId: ref.printavoId }, "workorder page fetch failed");
    return fail(timedOut ? "Timed out loading the page" : "Could not load the page");
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** Per-order fragments — PQ3 (auto-print PDFs) will reuse this. */
export async function fetchWorkorderFragments(
  orderIds: string[],
  log: Logger,
): Promise<WorkorderFragment[] | null> {
  const rows = await db
    .select({
      printavoId: pvOrdersTable.printavoId,
      visualId: pvOrdersTable.visualId,
      data: pvOrdersTable.data,
    })
    .from(pvOrdersTable)
    .where(inArray(pvOrdersTable.printavoId, orderIds));
  if (rows.length === 0) return null;

  const byId = new Map(rows.map((r) => [r.printavoId, r]));
  // Preserve the caller's selection order, skipping unknown ids.
  const refs: OrderRef[] = orderIds
    .filter((id) => byId.has(id))
    .map((id) => {
      const row = byId.get(id)!;
      const raw = row.data as { workorderUrl?: unknown } | null;
      const url = typeof raw?.workorderUrl === "string" ? raw.workorderUrl : null;
      return { printavoId: row.printavoId, visualId: row.visualId, url };
    });

  return mapWithConcurrency(refs, CONCURRENCY, (ref) => fetchOne(ref, log));
}

function cleanHead(headHtml: string): string {
  return headHtml
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<base[^>]*>/gi, "");
}

function errorInner(f: WorkorderFragment): string {
  return `<div style="padding: 24px; margin: 24px; border: 2px solid #dc2626; font-family: sans-serif;">
    <h2 style="color: #dc2626; margin: 0 0 8px;">Order #${f.visualId} — workorder unavailable</h2>
    <p style="margin: 0;">${f.error ?? "Unknown error"}. Print this one from Printavo directly.</p>
  </div>`;
}

/**
 * Print CSS matching the original bulk-print app: keep the grey table
 * backgrounds Printavo renders on screen when the page goes to paper.
 */
const WORKORDER_PRINT_CSS = `
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  thead th { background-color: #e0e0e0 !important; }
  .td-bg-grey { background-color: #eeeeee !important; }
  .imprints-well td { background-color: #f2f2f2 !important; }
  .well:has(.invoice__top-meta) { background-color: #eeeeee !important; }
  .invoice__top-meta { background-color: #eeeeee !important; }
  tr.line-item-assets td { background-color: #eeeeee !important; }
  .invoice__bottom-meta .form-group:first-child {
    background-color: #e0e0e0 !important; padding: 4px 8px !important; border-radius: 3px !important;
  }
  .page-content { padding: 12px !important; }
`;

export interface CombinedHtmlOptions {
  /** CSP nonce for the page-controls script (route sets the matching header). */
  nonce: string;
  /** Hide attachment/mockup pages (Printavo's .printing__keep-together blocks). */
  excludeAttachments?: boolean;
  /** Mark all selected workorders as reprints, or only the specified orders. */
  isReprint?: boolean;
  reprintOrderIds?: string[];
}

/**
 * One printable HTML document: interactive preview with a sticky Print All
 * header and a per-order Exclude toggle, page break between orders.
 */
export async function buildCombinedWorkordersHtml(
  orderIds: string[],
  log: Logger,
  opts: CombinedHtmlOptions,
): Promise<string | null> {
  const fragments = await fetchWorkorderFragments(orderIds, log);
  if (!fragments) return null;

  const total = fragments.length;
  const failed = fragments.filter((f) => f.bodyHtml == null).length;
  const firstOk = fragments.find((f) => f.bodyHtml != null);
  const base = firstOk?.origin ? `<base href="${firstOk.origin}/">` : "";
  const head = firstOk?.headHtml ? cleanHead(firstOk.headHtml) : "";
  const bodyAttrs = firstOk?.bodyAttrs ?? "";

  const cards = fragments
    .map((f, i) => {
      const label =
        f.bodyHtml != null
          ? `Order #${f.visualId} — ${i + 1} of ${total}`
          : `Order #${f.visualId} — failed to load`;
      const content = f.bodyHtml ?? errorInner(f);
      return `<div class="pq-wrapper" id="pq-wrapper-${i}">
    <div class="pq-controls">
      <span class="pq-label">${label}</span>
      <button type="button" class="pq-exclude-btn" data-exclude-idx="${i}">Exclude</button>
    </div>
    <div class="pq-page">${opts.isReprint || opts.reprintOrderIds?.includes(f.printavoId) ? REPRINT_BANNER_HTML : ""}${content}</div>
  </div>${i < total - 1 ? `\n  <div class="pq-divider">&#8213; page break &#8213;</div>` : ""}`;
    })
    .join("\n  ");

  return `<!DOCTYPE html>
<html>
<head>
${base}
<meta charset="utf-8">
<title>Workorders (${total})</title>
${head}
<style>
  ${WORKORDER_PRESENTATION_CSS}
  ${opts.excludeAttachments ? ".printing__keep-together { display: none !important; }" : ""}

  @media print {
    .pq-header, .pq-controls, .pq-divider { display: none !important; }
    .pq-wrapper.pq-excluded { display: none !important; }
    .pq-wrapper { page-break-after: always; }
    .pq-wrapper:last-of-type { page-break-after: auto; }
    ${WORKORDER_PRINT_CSS}
  }

  @media screen {
    body { background: #f3f4f6 !important; margin: 0; padding: 0; }
    .pq-header {
      position: sticky; top: 0; z-index: 100;
      background: #1e293b; color: white;
      padding: 12px 24px;
      display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      font-family: system-ui, -apple-system, sans-serif;
    }
    .pq-header h1 { font-size: 16px; font-weight: 600; margin: 0; }
    .pq-header p { font-size: 13px; opacity: 0.7; margin: 2px 0 0; }
    .pq-print-btn {
      background: #059669; color: white; border: none;
      padding: 10px 24px; border-radius: 6px; font-size: 14px;
      font-weight: 600; cursor: pointer;
    }
    .pq-print-btn:hover { background: #047857; }
    .pq-print-btn:disabled { background: #64748b; cursor: not-allowed; }
    .pq-wrapper { max-width: 1000px; margin: 24px auto; }
    .pq-wrapper.pq-excluded .pq-page { opacity: 0.35; filter: grayscale(0.5); }
    .pq-page { background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 0 0 4px 4px; overflow: hidden; }
    .pq-controls {
      background: #1e293b; border-radius: 4px 4px 0 0;
      padding: 8px 14px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .pq-label { color: #94a3b8; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
    .pq-exclude-btn {
      background: transparent; border: 1px solid #475569; color: #94a3b8;
      padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 500;
      cursor: pointer; transition: all 0.12s ease;
    }
    .pq-exclude-btn:hover { border-color: #ef4444; color: #f87171; background: rgba(239,68,68,0.08); }
    .pq-wrapper.pq-excluded .pq-exclude-btn { border-color: #22c55e; color: #4ade80; background: rgba(34,197,94,0.08); }
    .pq-divider { max-width: 1000px; margin: 0 auto; padding: 6px 0; text-align: center; font-size: 11px; color: #9ca3af; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; font-family: system-ui, -apple-system, sans-serif; }
  }
</style>
</head>
<body${bodyAttrs}>
  <div class="pq-header">
    <div>
      <h1>Combined Workorders</h1>
      <p id="pq-subtitle">${total} of ${total} will print${failed > 0 ? ` — ${failed} failed to load` : ""}</p>
    </div>
    <button type="button" class="pq-print-btn" id="pq-print-btn">Print All (${total})</button>
  </div>
  ${cards}
  <script nonce="${opts.nonce}">
    (function () {
      var total = ${total};
      var excluded = {};
      var subtitle = document.getElementById('pq-subtitle');
      var printBtn = document.getElementById('pq-print-btn');

      printBtn.addEventListener('click', function () { window.print(); });

      function refresh() {
        var count = 0;
        for (var k in excluded) if (excluded[k]) count++;
        var included = total - count;
        subtitle.textContent = included + ' of ' + total + ' will print';
        printBtn.textContent = included === total ? 'Print All (' + total + ')' : 'Print Selected (' + included + ')';
        printBtn.disabled = included === 0;
      }

      var btns = document.querySelectorAll('[data-exclude-idx]');
      for (var i = 0; i < btns.length; i++) {
        (function (btn) {
          var idx = btn.getAttribute('data-exclude-idx');
          btn.addEventListener('click', function () {
            excluded[idx] = !excluded[idx];
            document.getElementById('pq-wrapper-' + idx).classList.toggle('pq-excluded', !!excluded[idx]);
            btn.textContent = excluded[idx] ? 'Include' : 'Exclude';
            refresh();
          });
        })(btns[i]);
      }
    })();
  </script>
</body>
</html>`;
}
