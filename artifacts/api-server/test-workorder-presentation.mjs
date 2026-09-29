import assert from "node:assert/strict";
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

// Offline regression: representative Printavo selectors verified against a
// public workorder, with synthetic content only. No Printavo calls/printing.
const outfile = join(import.meta.dirname, ".workorder-presentation.test.mjs");
await build({
  stdin: {
    contents: `export * from "./src/lib/printQueue/workorderPresentation";
      export * from "./src/lib/printQueue/autoPrint/pdf";`,
    resolveDir: import.meta.dirname,
  },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{
    name: "offline-db",
    setup(build) {
      build.onResolve({ filter: /\/workorderHtml$/ }, () => ({ path: "workorder", namespace: "offline" }));
      build.onLoad({ filter: /.*/, namespace: "offline" }, () => ({
        contents: `export const isAllowedWorkorderUrl = (url) => url.startsWith("https://fixture.printavo.com/");`,
      }));
    },
  }],
});
let browser;
let renderer;
try {
  const { WORKORDER_PRESENTATION_CSS, REPRINT_BANNER_HTML, openPdfRenderer } = await import(outfile);
  const rows = Array.from({ length: 110 }, (_, i) =>
    `<tr class="line-item-detail"><td>Fixture garment ${i + 1}</td><td>12</td></tr>${i === 0 ? '<tr class="line-item-assets"><td>Asset, not a garment</td></tr>' : ""}`).join("");
  const html = `<!doctype html><html><head><style>
    body { margin: 0; font: 14px Arial; } table { width:100%; border-collapse:collapse; }
    td,th { padding:10px; } thead { display:table-header-group; }
    ${WORKORDER_PRESENTATION_CSS}
    </style></head><body>${REPRINT_BANNER_HTML}
    <h1>Offline workorder fixture</h1><table class="table__invoice-line-items" data-component="lig-table">
    <thead><tr><th>Garment</th><th>Quantity</th></tr></thead><tbody>${rows}</tbody></table>
    <table id="unrelated"><tbody><tr><td>Unrelated</td></tr><tr><td>No stripe</td></tr></tbody></table>
    </body></html>`;
  browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || execSync("command -v chromium", { encoding: "utf8" }).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setContent(html);
  await page.emulateMediaType("print");
  const result = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".line-item-detail > td:first-child")];
    return {
      colors: cells.slice(0, 4).map(cell => getComputedStyle(cell).backgroundColor),
      other: getComputedStyle(document.querySelector("#unrelated tr:last-child td")).backgroundColor,
      banner: document.body.firstElementChild.textContent,
      top: document.body.firstElementChild.getBoundingClientRect().top,
    };
  });
  assert.deepEqual(result.colors, ["rgb(255, 255, 255)", "rgb(238, 238, 238)", "rgb(255, 255, 255)", "rgb(238, 238, 238)"]);
  assert.equal(result.other, "rgba(0, 0, 0, 0)");
  assert.equal(result.banner, "UPDATED / REPRINT");
  assert.equal(result.top, 0);
  await page.screenshot({ path: "/tmp/workorder-presentation.png" });
  renderer = await openPdfRenderer();
  for (let i = 0; i < 2; i++) {
    const pdf = await renderer.renderHtml(html);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
    assert.ok(pages > 1, `Expected multiple pages, got ${pages}`);
    console.log(`Local render ${i + 1}: ${pages} pages; PDF ${pdf.length} bytes`);
  }
  console.log("PASS: print stripes skip asset rows/unrelated tables; reprint banner is first at top; repeated local PDF renders.");
} finally {
  await renderer?.close();
  await browser?.close();
  await rm(outfile, { force: true });
}