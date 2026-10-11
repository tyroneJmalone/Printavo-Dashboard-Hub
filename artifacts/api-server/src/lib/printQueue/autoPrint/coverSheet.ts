import { workorderHeaderText } from "./workorderHeader";

export interface CoverDetails {
  visualId?: string | number;
  nickname?: string | null;
  productionDueAt?: string | null;
  customerDueAt?: string | null;
  statusName?: string | null;
}
export function coverDate(value?: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleDateString("en-US", { timeZone: "UTC" });
}
/** Uses only images already loaded by the authorized Printavo workorder.
 * Text is assigned via textContent, never interpreted as HTML. */
export function coverSheetScript(details: CoverDetails, isReprint = false): string {
  const data = { ...details, productionDate: coverDate(details.productionDueAt), customerDate: coverDate(details.customerDueAt),
    banner: workorderHeaderText(details.nickname, isReprint) };
  return `(async () => {
    const data = ${JSON.stringify(data)};
    const originals = [...document.querySelectorAll(".printing__keep-together img")]
      .filter(image => !image.closest(".production-preview__wrapper, .production-file-preview__wrapper, .production-file-name"));
    const images = [...new Map(originals.filter(i => i.currentSrc || i.src).map(i => [i.currentSrc || i.src, i])).values()];
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
    const pages = Math.max(1, Math.ceil(images.length / 6));
    const fragment = document.createDocumentFragment();
    for (let page = 0; page < pages; page++) {
      const sheet = document.createElement("section");
      sheet.className = "pq-cover-sheet";
      const add = (tag, text, parent = sheet) => { const el = document.createElement(tag); el.textContent = text; parent.append(el); return el; };
      if (data.banner) add("div", data.banner).className = "pq-cover-banner";
      add("h1", "Workorder #" + (data.visualId ?? "Not recorded"));
      add("h2", data.nickname || "No nickname");
      add("p", "Production Due: " + data.productionDate + "   |   Customer Due: " + data.customerDate);
      add("p", "Status at printing: " + (data.statusName || "Not recorded"));
      if (pages > 1) add("p", "Cover images " + (page + 1) + " of " + pages);
      const grid = document.createElement("div"); grid.className = "pq-cover-grid"; sheet.append(grid);
      for (const [offset, original] of images.slice(page * 6, page * 6 + 6).entries()) {
        const figure = document.createElement("figure");
        const { image, loaded } = decoded[page * 6 + offset];
        figure.append(image);
        if (!loaded) { image.remove(); add("figcaption", "Image unavailable — review original workorder", figure); }
        else if (original.alt) add("figcaption", original.alt, figure);
        grid.append(figure);
      }
      if (!images.length) add("p", "No product/design attachment images on this workorder.");
      fragment.append(sheet);
    }
    document.body.prepend(fragment);
  })()`;
}
export const COVER_SHEET_CSS = `
.pq-cover-sheet { box-sizing:border-box; width:100%; break-after:page; page-break-after:always; font-family:Arial,sans-serif; color:#111; padding:8px; }
.pq-cover-sheet h1 {font-size:26px; margin:0 0 8px}
.pq-cover-sheet h2 {font-size:17px; line-height:1.3; margin:0 0 12px; overflow-wrap:anywhere}
.pq-cover-sheet p {font-size:12px !important; margin:6px 0}
.pq-cover-banner {border:4px solid #111; font-size:25px !important; font-weight:bold; text-align:center; padding:8px; margin-bottom:12px}
.pq-cover-grid {display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.pq-cover-grid figure {margin:0; height:190px; display:flex;flex-direction:column;align-items:center;justify-content:center;break-inside:avoid}
.pq-cover-grid img {max-width:100%;max-height:166px;object-fit:contain}
.pq-cover-grid figcaption {font-size:10px;text-align:center}
`;
