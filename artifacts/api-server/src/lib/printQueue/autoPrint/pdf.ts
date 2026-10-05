import { execSync } from "node:child_process";
import puppeteer, { type Browser } from "puppeteer-core";
import { logger } from "../../logger";
import { isAllowedWorkorderUrl } from "../workorderHtml";
import { WORKORDER_PRESENTATION_CSS } from "../workorderPresentation";
import { AUTO_PRINT_COMPACT_CSS, presentationScript, type PurchaseNote } from "./presentation";
import {
  closeBrowserBounded,
  launchBrowserWithRecovery,
} from "./browserLaunch";

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

/** Auto-print always excludes attachment pages; keep the option for older callers. */
export async function applyAutoPrintAttachmentOption(
  page: { addStyleTag(options: { content: string }): Promise<unknown> },
  _options?: { excludeAttachments?: boolean },
): Promise<void> {
  await page.addStyleTag({
    content: ".printing__keep-together { display: none !important; }",
  });
}

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

export interface WorkorderPdfOptions {
  purchaseNotes?: PurchaseNote[];
  excludeAttachments?: boolean;
  isReprint?: boolean;
}

export interface PdfRenderer {
  renderUrl(url: string, options?: WorkorderPdfOptions): Promise<Buffer>;
  /** Trusted, locally generated Hub PO HTML only; never navigates to Printavo. */
  renderHtml(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

export async function openPdfRenderer(options?: { maxStartupAttempts?: number }): Promise<PdfRenderer> {
  const executablePath = chromiumPath();
  const browser: Browser = await launchBrowserWithRecovery({
    logger,
    maxAttempts: options?.maxStartupAttempts,
    launch: async ({ signal, timeoutMs }) => {
      let launched: Browser | undefined;
      try {
        launched = await puppeteer.launch({
          executablePath,
          headless: true,
          // Pipe avoids the DevTools WebSocket URL-on-stdout handshake that
          // has timed out in production.
          pipe: true,
          timeout: timeoutMs,
          // Keep protocol work aligned with the existing page timeout; the
          // startup watchdog below is independently capped at 30 seconds.
          protocolTimeout: PAGE_TIMEOUT_MS,
          waitForInitialPage: false,
          signal,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
          ],
        });
        // With pipe transport there is no stdout readiness handshake. A small
        // CDP command proves Chromium is responsive; the recovery helper's
        // AbortSignal/watchdog bounds this startup probe.
        await launched.version();
        return launched;
      } catch (error) {
        if (launched) await closeBrowserBounded(launched);
        throw error;
      }
    },
  });

  return {
    async renderUrl(url: string, options?: WorkorderPdfOptions): Promise<Buffer> {
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
        // Inject after navigation so Printavo's own styles cannot override it.
        await applyAutoPrintAttachmentOption(page, options);
        await page.addStyleTag({ content: WORKORDER_PRESENTATION_CSS });
        await page.addStyleTag({ content: AUTO_PRINT_COMPACT_CSS });
        await page.evaluate(presentationScript(options?.purchaseNotes ?? []));
        if (options?.isReprint) {
          await page.evaluate(`(() => {
            const banner = document.createElement("div");
            banner.className = "pq-reprint-banner";
            banner.textContent = "UPDATED";
            document.body.prepend(banner);
          })()`);
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
    async renderHtml(html: string): Promise<Buffer> {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        // Hub POs embed their logos. Disallow remote resources and scripts:
        // rendering must not cause external writes, auth, or print actions.
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          if (/^(data:|about:)/i.test(request.url())) void request.continue();
          else void request.abort();
        });
        await page.setContent(html, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
        const pdf = await page.pdf({
          format: "letter",
          printBackground: true,
          margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
        });
        return Buffer.from(pdf);
      } finally {
        await context.close().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      await closeBrowserBounded(browser);
    },
  };
}
