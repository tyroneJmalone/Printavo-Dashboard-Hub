import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import test from "node:test";
import puppeteer, { type Browser } from "puppeteer-core";
import {
  launchBrowserWithRecovery,
} from "../src/lib/printQueue/autoPrint/browserLaunch";

function chromiumPath(): string | null {
  if (process.env.CHROMIUM_EXECUTABLE_PATH) {
    return process.env.CHROMIUM_EXECUTABLE_PATH;
  }
  try {
    return execSync("command -v chromium", { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

test("local tiny HTML renders to a PDF without external side effects", async (t) => {
  const executablePath = chromiumPath();
  if (!executablePath) {
    t.skip("local Chromium is not installed");
    return;
  }

  const browser = await launchBrowserWithRecovery<Browser>({
    logger: { info() {}, warn() {} },
    launch: async ({ signal, timeoutMs }) => {
      const launched = await puppeteer.launch({
        executablePath,
        headless: true,
        pipe: true,
        waitForInitialPage: false,
        timeout: timeoutMs,
        protocolTimeout: timeoutMs,
        signal,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      await launched.version();
      return launched;
    },
  });

  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await page.setContent("<h1>Auto-print smoke</h1>");
      const pdf = await page.pdf({ format: "letter" });
      assert.ok(pdf.byteLength > 100);
      assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");
    } finally {
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
});