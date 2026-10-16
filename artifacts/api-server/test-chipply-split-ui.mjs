// Isolated interactive component regression: no Hub server, auth, DB or external APIs.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const { chromium, expect } = createRequire(new URL("../hub/package.json", import.meta.url))("@playwright/test");
const bundle = await build({
  entryPoints: ["../hub/tests/chipply-split/replacement.fixture.tsx"], absWorkingDir: import.meta.dirname,
  bundle: true, platform: "browser", format: "iife", jsx: "automatic", write: false,
});
const browser = await chromium.launch({ executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(), args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByText("PRINT: Front · Split review: active", { exact: true }).click();
  await page.getByRole("button", { name: "Simulate candidate replacement" }).click();
  const reviewReplacement = async () => {
    await expect(page.getByText(/are no longer candidates and have been removed/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Invoice #100" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Invoice #300" })).not.toBeChecked();
    await page.getByRole("checkbox", { name: "Invoice #300" }).check();
    await page.getByRole("button", { name: "Preview selected invoices together" }).click();
    await expect(page.getByText("Full coverage verified · ready for explicit review")).toBeVisible();
    await page.getByRole("checkbox", { name: /I reviewed these invoices/ }).check();
    await page.getByRole("textbox", { name: "Review / revocation reason" }).fill("Replacement split verified");
    await page.getByRole("button", { name: "Approve reviewed split in Hub" }).click();
    await expect(page.getByText("PRINT: Front · Split review: active", { exact: true })).toBeVisible();
  };
  await reviewReplacement();
  await page.getByRole("button", { name: "Load revoked review" }).click();
  await reviewReplacement();
  const requests = await page.evaluate(() => window.splitRequests);
  assert.deepEqual(requests.map(r => r.action), ["preview", "approve", "preview", "approve"]);
  for (const request of requests) assert.deepEqual(request.invoiceIds, ["a", "c"]);
  console.log("PASS: stale and revoked reviews recover through selection, preview and approval without obsolete IDs.");
} finally { await browser.close(); }
