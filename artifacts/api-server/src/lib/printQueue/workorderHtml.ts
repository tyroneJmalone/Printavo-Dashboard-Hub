import type { Logger } from "pino";
import { db, pvOrdersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

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

function isAllowedWorkorderUrl(url: string): boolean {
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

function errorBlock(f: WorkorderFragment): string {
  return `<div class="pq-error" style="page-break-after: always; padding: 24px; margin: 24px; border: 2px solid #dc2626; font-family: sans-serif;">
    <h2 style="color: #dc2626; margin: 0 0 8px;">Order #${f.visualId} — workorder unavailable</h2>
    <p style="margin: 0;">${f.error ?? "Unknown error"}. Print this one from Printavo directly.</p>
  </div>`;
}

/** One printable HTML document with a page break between orders. */
export async function buildCombinedWorkordersHtml(
  orderIds: string[],
  log: Logger,
): Promise<string | null> {
  const fragments = await fetchWorkorderFragments(orderIds, log);
  if (!fragments) return null;

  const firstOk = fragments.find((f) => f.bodyHtml != null);
  const base = firstOk?.origin ? `<base href="${firstOk.origin}/">` : "";
  const head = firstOk?.headHtml ? cleanHead(firstOk.headHtml) : "";
  const bodyAttrs = firstOk?.bodyAttrs ?? "";

  const parts = fragments.map((f) =>
    f.bodyHtml != null
      ? `<div class="pq-order" style="page-break-after: always;">${f.bodyHtml}</div>`
      : errorBlock(f),
  );

  return `<!DOCTYPE html>
<html>
<head>
${base}
<meta charset="utf-8">
<title>Workorders (${fragments.length})</title>
${head}
<style>
  .pq-order:last-child, .pq-error:last-child { page-break-after: auto; }
</style>
</head>
<body${bodyAttrs}>
${parts.join("\n")}
</body>
</html>`;
}
