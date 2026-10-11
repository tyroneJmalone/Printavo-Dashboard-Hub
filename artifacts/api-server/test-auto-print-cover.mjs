import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const dir = mkdtempSync(path.join(tmpdir(), "autoprint-cover-"));
let browser;
try {
  const output = path.join(dir, "cover.mjs");
  await build({ entryPoints: ["src/lib/printQueue/autoPrint/coverSheet.ts"], absWorkingDir: import.meta.dirname, outfile: output, bundle: true, platform: "node", format: "esm" });
  const { coverSheetScript, COVER_SHEET_CSS, coverStatusLabel } = await import(output);
  for (const [status, expected] of [
    ["🟢 MERCH - MIXED DECO Ready 4 Production", "MERCH - Mixed Deco"],
    ["MERcH – Print Ready 2 Pick/Pack", "MERCH - Print"],
    ["🏁 MERCH - EMB Pick/Pack COMPLETE", "MERCH - EMB"],
    ["MERCH — HEAT Ready 4 Production", "MERCH - HEAT"],
    ["MERCH – Ordered", "MERCH"],
    ["PRINT-Picked UP", "PRINT"],
    ["🟢 EMB - Waiting 4 Blanks", "EMB"],
    [" HEAT  - Complete", "HEAT"],
    ["MIXED DECO - Complete", "Mixed Deco"],
    ["DTG - Complete", "DTG"],
    [null, "Not recorded"],
  ]) assert.equal(coverStatusLabel(status), expected);
  browser = await puppeteer.launch({ executablePath: execSync("command -v chromium", { encoding: "utf8" }).trim(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 816, height: 1056 });
  await page.setRequestInterception(true);
  page.on("request", request => /^(data:|about:)/.test(request.url()) ? request.continue() : request.abort());
  const svg = index => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#eee"/><path d="M100 40L65 65L85 95L105 85V155H195V85L215 95L235 65L200 40L175 55H125Z" fill="#234d63"/><text x="150" y="110" text-anchor="middle" fill="white">Design ${index}</text></svg>`).toString("base64")}`;
  const fixture = count => `<html><head><style>${COVER_SHEET_CSS}.printing__keep-together{display:none}</style></head><body><main id="original"><h1>Original workorder</h1><p>Keep production notes and line details.</p></main><div class="printing__keep-together">${Array.from({ length: count }, (_, i) => `<img src="${svg(i)}" alt="Product ${i + 1}"/>`).join("")}<img src="${svg(0)}" alt="Duplicate"/><div class="production-preview__wrapper"><img src="${svg(999)}"/></div></div></body></html>`;
  for (const count of [1, 6, 7, 18, 40]) {
    await page.setContent(fixture(count));
    await page.evaluate(coverSheetScript({ visualId: "EXAMPLE", nickname: "Illustrative Rush — Embroidered chest / Heat sleeve", productionDueAt: "2026-10-12T00:00:00Z", customerDueAt: "2026-10-14T00:00:00Z", statusName: "MERCH – Ordered" }, true));
    assert.equal(await page.$$eval(".pq-cover-sheet", els => els.length), 1);
    assert.equal(await page.$eval(".pq-cover-heading", el => getComputedStyle(el.children[0]).fontSize === getComputedStyle(el.children[1]).fontSize), true);
    assert.equal(await page.$eval(".pq-cover-heading span:last-child", el => el.textContent), "MERCH");
    assert.equal(await page.$$eval(".pq-cover-grid img", els => els.length), count);
    assert.equal(await page.$eval("#original p", el => el.textContent), "Keep production notes and line details.");
    assert.ok((await page.$eval(".pq-cover-sheet", el => el.textContent)).includes("10/12/2026"));
    assert.ok((await page.$eval(".pq-cover-banner", el => el.textContent)).includes("UPDATED"));
    {
      await page.screenshot({ path: "/tmp/autoprint-cover-proof.png", fullPage: true });
      await page.pdf({ path: "/tmp/autoprint-cover-proof.pdf", format: "letter", printBackground: true, margin: { top: ".4in", bottom: ".4in", left: ".4in", right: ".4in" } });
      assert.match(execSync("pdfinfo /tmp/autoprint-cover-proof.pdf", { encoding: "utf8" }), /Pages:\s+2/);
    }
  }
  await page.setContent("<body><main>Original</main></body>");
  await page.evaluate(coverSheetScript({ visualId: 1, nickname: "<script>evil()</script>" }));
  assert.equal(await page.$$eval("script", els => els.length), 0);
  assert.ok((await page.$eval(".pq-cover-sheet", el => el.textContent)).includes("No product/design"));
  console.log("PASS: offline cover rendering, image deduplication, production-file exclusion, overflow, dates, urgency/reprint, original body, empty images and escaping.");
} finally {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
}
