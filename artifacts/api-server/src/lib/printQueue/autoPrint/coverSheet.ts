import { workorderHeaderText } from "./workorderHeader";
import type { PvOrderDetailNode } from "@workspace/printavo";

export interface CoverDetails {
  visualId?: string | number;
  nickname?: string | null;
  productionDueAt?: string | null;
  customerDueAt?: string | null;
  statusName?: string | null;
  destinationStatusName?: string | null;
  totalQuantity?: number | null;
}
/** Sum units, not row count or imprint count. Missing/incomplete data is unknown. */
export function coverTotalQuantity(detail?: PvOrderDetailNode): number | null {
  if (!detail?.lineItemGroups || detail.lineItemGroups.pageInfo.hasNextPage) return null;
  let total = 0;
  const seen = new Set<string>();
  for (const group of detail.lineItemGroups.nodes) {
    if (group.lineItems.pageInfo.hasNextPage) return null;
    for (const line of group.lineItems.nodes) {
      if (seen.has(line.id)) continue;
      seen.add(line.id);
      if (typeof line.items !== "number" || !Number.isFinite(line.items) || line.items < 0) return null;
      total += line.items;
    }
  }
  return total;
}
export function coverDate(value?: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleDateString("en-US", { timeZone: "UTC" });
}
/** Cover-only descriptor; never changes the source status or routing. */
export function coverStatusLabel(value?: string | null): string {
  const status = (value ?? "").replace(/^[^a-z0-9]+/i, "").replace(/\s+/g, " ").trim();
  if (!status) return "Not recorded";
  const merch = /^merch\b/i.test(status);
  const descriptor = merch ? status.replace(/^merch\b[\s:–—-]*/i, "") : status;
  const method = descriptor.match(/^(mixed(?:[\s-]+deco(?:ration)?)?|screen[\s-]+print(?:ing)?|print(?:ing)?|emb(?:roidery)?|heat(?:[\s-]+applied)?|dtf|dtg|sublimation)\b/i)?.[0];
  if (merch && !method) return "MERCH";
  let label = method ?? descriptor.split(/[\s:–—-]+/)[0];
  if (/^mixed/i.test(label)) label = "Mixed Deco";
  else if (/^(screen|print)/i.test(label)) label = merch ? "Print" : "PRINT";
  else if (/^emb/i.test(label)) label = "EMB";
  else if (/^heat/i.test(label)) label = "HEAT";
  else label = label.toUpperCase();
  return merch ? `MERCH - ${label}` : label;
}
/** Uses only images already loaded by the authorized Printavo workorder.
 * Text is assigned via textContent, never interpreted as HTML. */
export function coverSheetScript(details: CoverDetails, isReprint = false): string {
  // The nickname prefix describes the job even while its status is MERCH - Ordered.
  // Presentation only: do not infer routing or per-line decoration assignments.
  const nicknameMethod = details.nickname?.match(/^\s*MERCH\s*[-–—]\s*(PRINT|HEAT|EMB|MIXED)\b/i)?.[1];
  const merchLabel = nicknameMethod ? `MERCH - ${nicknameMethod.toUpperCase()}` : coverStatusLabel(details.statusName);
  const isMerch = /^MERCH\b/.test(merchLabel);
  const destination = coverStatusLabel(details.destinationStatusName);
  const methodLabel = destination === "EMB" ? "EMBROIDERY" : destination === "Mixed Deco" ? "MIXED" : destination;
  const data = { ...details, isMerch, statusName: isMerch ? merchLabel : details.destinationStatusName ? methodLabel : "Destination not mapped", productionDate: coverDate(details.productionDueAt), customerDate: coverDate(details.customerDueAt),
    banner: workorderHeaderText(details.nickname, isReprint) };
  return `(async () => {
    const data = ${JSON.stringify(data)};
    const originals = [...document.querySelectorAll(".printing__keep-together img")]
      .filter(image => !image.closest(".production-preview__wrapper, .production-file-preview__wrapper, .production-file-name"));
    const availableImages = [...new Map(originals.filter(i => i.currentSrc || i.src).map(i => [i.currentSrc || i.src, i])).values()];
    const images = data.isMerch ? availableImages : originals.filter(i => i.currentSrc || i.src).slice(0, 1);
    // Decode concurrently so missing references share one bounded wait rather
    // than multiplying the render timeout by the number of images.
    const decoded = await Promise.all(images.map(async original => {
      const image = document.createElement("img");
      image.src = original.currentSrc || original.src; image.loading = "eager";
      const loaded = await Promise.race([
        image.decode().then(() => true).catch(() => false),
        new Promise(resolve => setTimeout(() => resolve(false), 5000))
      ]);
      return { image, loaded };
    }));
    const pages = 1;
    const fragment = document.createDocumentFragment();
    for (let page = 0; page < pages; page++) {
      const sheet = document.createElement("section");
      sheet.className = "pq-cover-sheet" + (data.isMerch ? "" : " pq-cover-standard");
      const add = (tag, text, parent = sheet) => { const el = document.createElement(tag); el.textContent = text; parent.append(el); return el; };
      if (data.banner) add("div", data.banner).className = "pq-cover-banner";
      const title = document.createElement("div");
      title.className = "pq-cover-title";
      sheet.append(title);
      const heading = add("h1", "", title);
      heading.className = "pq-cover-heading";
      add("span", "#" + (data.visualId ?? "Not recorded"), heading);
      add("span", data.statusName || "Not recorded", heading).className = "pq-cover-method";
      add("h2", data.nickname || "No nickname", title);
      add("p", "Production Due: " + data.productionDate + "   |   Customer Due: " + data.customerDate, title).className = "pq-cover-dates";
      if (data.isMerch) {
        add("p", "Total QTY: " + (Number.isFinite(data.totalQuantity) && data.totalQuantity >= 0 ? data.totalQuantity.toLocaleString("en-US") : "Not recorded"), title).className = "pq-cover-quantity";
      }
      const grid = document.createElement("div"); grid.className = "pq-cover-grid"; sheet.append(grid);
      const columns = Math.max(1, Math.ceil(Math.sqrt(images.length * 0.8)));
      grid.style.gridTemplateColumns = "repeat(" + columns + ", minmax(0, 1fr))";
      grid.style.gridTemplateRows = "repeat(" + Math.max(1, Math.ceil(images.length / columns)) + ", minmax(0, 1fr))";
      for (const [offset, original] of images.entries()) {
        const figure = document.createElement("figure");
        const { image, loaded } = decoded[offset];
        figure.append(image);
        if (!loaded) { image.remove(); add("figcaption", "Image unavailable — review original workorder", figure); }
        else if (original.alt) add("figcaption", original.alt, figure);
        grid.append(figure);
      }
      if (!images.length) add("p", "No product/design attachment images on this workorder.");
      if (!data.isMerch) sheet.append(title);
      fragment.append(sheet);
    }
    document.body.prepend(fragment);
    // Keep even unusually long headings inside the fixed letter-page budget.
    const sheet = document.querySelector(".pq-cover-sheet");
    const header = sheet.querySelector(".pq-cover-heading");
    let headingSize = 24;
    while (header.scrollWidth > header.clientWidth && headingSize > 8) {
      header.style.setProperty("font-size", (--headingSize) + "px", "important");
    }
  })()`;
}
export const COVER_SHEET_CSS = `
.pq-cover-sheet { box-sizing:border-box; width:100%; height:10in; display:flex; flex-direction:column; break-after:page; page-break-after:always; break-inside:avoid; font-family:Arial,sans-serif; color:#111; padding:8px; }
.pq-cover-sheet .pq-cover-heading {display:flex; justify-content:space-between; gap:18px; align-items:baseline; font-size:24px !important; line-height:1.15 !important; margin:0 0 12px; flex-shrink:0}
.pq-cover-sheet .pq-cover-heading span {font-size:inherit !important; font-weight:bold !important; line-height:inherit !important}
.pq-cover-heading span:first-child {white-space:nowrap}
.pq-cover-sheet .pq-cover-heading .pq-cover-method {margin-left:auto; flex:0 0 auto; white-space:nowrap; padding:5px 9px; background:#000 !important; color:#fff !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important}
.pq-cover-title {flex-shrink:0}
.pq-cover-standard .pq-cover-title {margin-top:16px}
.pq-cover-standard .pq-cover-heading {justify-content:space-between}
.pq-cover-standard .pq-cover-heading span:last-child {margin-left:auto;text-align:right}
.pq-cover-standard .pq-cover-grid {margin-top:0}
.pq-cover-sheet h2 {font-size:17px !important; line-height:1.3; margin:0 0 12px; overflow-wrap:anywhere; flex-shrink:0}
.pq-cover-sheet p {font-size:12px !important; margin:6px 0}
.pq-cover-sheet .pq-cover-dates {font-size:18px !important; font-weight:bold; line-height:1.3 !important; flex-shrink:0}
.pq-cover-sheet .pq-cover-quantity {font-size:18px !important; font-weight:bold; line-height:1.3 !important; flex-shrink:0}
.pq-cover-banner {border:4px solid #111; font-size:25px !important; font-weight:bold; text-align:center; padding:8px; margin-bottom:12px}
.pq-cover-grid {display:grid;gap:10px;margin-top:16px;flex:1;min-height:0}
.pq-cover-grid figure {margin:0; min-width:0;min-height:0; display:flex;flex-direction:column;align-items:center;justify-content:center;break-inside:avoid}
.pq-cover-grid img {width:100%;height:100%;min-height:0;flex:1;object-fit:contain}
.pq-cover-grid figcaption {font-size:10px !important;text-align:center;flex-shrink:0;overflow-wrap:anywhere}
`;
