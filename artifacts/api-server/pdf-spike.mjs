import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import { writeFileSync, statSync } from "node:fs";

const chrome = execSync("command -v chromium").toString().trim();
console.log("chromium:", chrome);

const url = process.argv[2];
const t0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});
console.log("launched in", Date.now() - t0, "ms");

const page = await browser.newPage();
const t1 = Date.now();
await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
console.log("page loaded in", Date.now() - t1, "ms");

const t2 = Date.now();
const pdf = await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" } });
console.log("pdf rendered in", Date.now() - t2, "ms");

writeFileSync("/tmp/spike-workorder.pdf", pdf);
console.log("pdf size:", statSync("/tmp/spike-workorder.pdf").size, "bytes");
await browser.close();
console.log("SPIKE OK — total", Date.now() - t0, "ms");
