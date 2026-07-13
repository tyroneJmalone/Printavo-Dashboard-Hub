import { execSync } from "node:child_process";
import puppeteer, { type Browser } from "puppeteer-core";
import { isAllowedWorkorderUrl } from "../workorderHtml";

/**
 * Workorder PDF rendering via headless Chromium (PQ3a spike-verified:
 * ~6.5s one-time launch, ~3s per page after that).
 *
 * One browser per engine run — callers MUST close() in a finally block.
 * URLs are re-validated against the Printavo allowlist here even though
 * they come from pv_orders, so no future caller can render an off-domain
 * page by mistake.
 */

const PAGE_TIMEOUT_MS = 30_000;

function chromiumPath(): string {
  const override = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (override) return override;
  try {
    const found = execSync("command -v chromium", { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    /* fall through */
  }
  throw new Error(
    "Chromium not found — install it or set CHROMIUM_EXECUTABLE_PATH",
  );
}

export interface PdfRenderer {
  renderUrl(url: string): Promise<Buffer>;
  close(): Promise<void>;
}

export async function openPdfRenderer(): Promise<PdfRenderer> {
  const browser: Browser = await puppeteer.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  return {
    async renderUrl(url: string): Promise<Buffer> {
      if (!isAllowedWorkorderUrl(url)) {
        throw new Error("Workorder URL is not a Printavo page");
      }
      // Fresh incognito context per render: Printavo's WAF returns 403 for
      // every navigation after the first within one browser session
      // (cookie/session-based, verified 2026-07-13 — 15s delays don't help,
      // fresh contexts do).
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      try {
        const resp = await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: PAGE_TIMEOUT_MS,
        });
        const finalUrl = resp?.url() ?? page.url();
        if (finalUrl && !isAllowedWorkorderUrl(finalUrl)) {
          throw new Error("Workorder URL redirected off Printavo");
        }
        if (resp && !resp.ok()) {
          throw new Error(`Printavo returned ${resp.status()}`);
        }
        const pdf = await page.pdf({
          format: "letter",
          printBackground: true,
          margin: {
            top: "0.4in",
            bottom: "0.4in",
            left: "0.4in",
            right: "0.4in",
          },
        });
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => undefined);
        await context.close().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      await browser.close().catch(() => undefined);
    },
  };
}
