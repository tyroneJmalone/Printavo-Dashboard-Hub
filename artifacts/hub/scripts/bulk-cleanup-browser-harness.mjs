#!/usr/bin/env node

/**
 * Isolated browser harness for the Purchasing "needs ordering" page.
 *
 * This bundles the real VendorOrders component and its real client-side
 * dependencies, but replaces the authenticated application shell and PO cart
 * drawer at build time. It never imports the Hub App entry point and never
 * forwards requests to another server.
 */
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, rm, stat } from "node:fs/promises";

const HOST = "127.0.0.1";
const PORT = 19887;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HUB_DIR = resolve(SCRIPT_DIR, "..");
const BUNDLE_PATH = "/tmp/bulk-cleanup-browser-harness.mjs";
const require = createRequire(import.meta.url);

function loadEsbuild() {
  const vitePackage = require.resolve("vite/package.json", {
    paths: [HUB_DIR],
  });
  const esbuildPackage = require.resolve("esbuild", {
    paths: [dirname(vitePackage)],
  });
  return require(esbuildPackage);
}

async function resolveHubImport(specifier) {
  const base = join(HUB_DIR, "src", specifier.slice(2));
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next extension.
    }
  }
  return base;
}

const appShellStub = `
  import React from "react";
  export function AppShell({ children }) {
    return React.createElement(
      "main",
      {
        "data-testid": "browser-harness-app-shell",
        style: { height: "100vh", background: "#020617", color: "#f8fafc" },
      },
      children,
    );
  }
`;

const cartDrawerStub = `
  import React from "react";
  export function CartDrawer({ open, onClose }) {
    if (!open) return null;
    return React.createElement(
      "aside",
      {
        "data-testid": "browser-harness-cart-drawer",
        style: {
          position: "fixed",
          right: "1rem",
          bottom: "1rem",
          zIndex: 100,
          padding: "0.75rem",
          border: "1px solid #334155",
          borderRadius: "0.5rem",
          background: "#0f172a",
        },
      },
      React.createElement("span", null, "PO cart stub"),
      React.createElement(
        "button",
        { type: "button", onClick: onClose, style: { marginLeft: "0.75rem" } },
        "Close",
      ),
    );
  }
`;

const entrySource = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import VendorOrders from "@/pages/VendorOrders";

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  createRoot(document.getElementById("root")).render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(VendorOrders),
    ),
  );
`;

async function buildHarness() {
  const esbuild = loadEsbuild();
  await esbuild.build({
    absWorkingDir: HUB_DIR,
    bundle: true,
    entryPoints: ["browser-harness-entry.tsx"],
    outfile: BUNDLE_PATH,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    sourcemap: "inline",
    logLevel: "info",
    plugins: [
      {
        name: "bulk-cleanup-isolation",
        setup(build) {
          build.onResolve(
            { filter: /^@\/components\/layout\/AppShell$/ },
            () => ({ path: "app-shell", namespace: "harness-stub" }),
          );
          build.onResolve(
            { filter: /^@\/components\/purchasing\/CartDrawer$/ },
            () => ({ path: "cart-drawer", namespace: "harness-stub" }),
          );
          build.onResolve(
            { filter: /^@\// },
            async (args) => ({ path: await resolveHubImport(args.path) }),
          );
          build.onResolve(
            { filter: /^browser-harness-entry\.tsx$/ },
            () => ({ path: "entry", namespace: "harness-entry" }),
          );
          build.onLoad(
            { filter: /.*/, namespace: "harness-entry" },
            () => ({ contents: entrySource, loader: "tsx", resolveDir: HUB_DIR }),
          );
          build.onLoad(
            { filter: /^app-shell$/, namespace: "harness-stub" },
            () => ({ contents: appShellStub, loader: "tsx", resolveDir: HUB_DIR }),
          );
          build.onLoad(
            { filter: /^cart-drawer$/, namespace: "harness-stub" },
            () => ({ contents: cartDrawerStub, loader: "tsx", resolveDir: HUB_DIR }),
          );
        },
      },
    ],
  });
}

const fixtureOrders = [
  {
    orderId: "900001",
    visualId: 900001,
    orderType: "invoice",
    nickname: "Synthetic Spring Uniforms",
    customerCompany: "Harness Athletic Club",
    contactName: "Casey Tester",
    statusName: "Production - Approved",
    invoiceAt: "2026-04-01T12:00:00.000Z",
    productionDueAt: "2026-04-20T12:00:00.000Z",
    customerDueAt: "2026-04-24T12:00:00.000Z",
    detailSyncedAt: "2026-04-02T12:00:00.000Z",
    lineItems: [
      {
        id: "900011",
        itemNumber: "PC61",
        color: "Navy",
        description: "Synthetic cotton tee",
        brand: "Port & Company",
        categoryName: "Apparel",
        items: 12,
        price: 9.5,
        sizes: [{ size: "M", count: 5 }, { size: "L", count: 7 }],
      },
      {
        id: "900012",
        itemNumber: null,
        color: "Black",
        description: "Synthetic missing-style line",
        brand: null,
        categoryName: "Apparel",
        items: 3,
        price: 7,
        sizes: [{ size: "OSFA", count: 3 }],
      },
      {
        id: "900013",
        itemNumber: "ST350",
        color: "Forest",
        description: "Synthetic performance shirt",
        brand: "Sport-Tek",
        categoryName: "Apparel",
        items: 0,
        price: 11,
        sizes: [],
      },
      {
        id: "900014",
        itemNumber: "5000",
        color: "Red",
        description: "Synthetic team tee",
        brand: "Gildan",
        categoryName: "Apparel",
        items: 8,
        price: 6.25,
        sizes: [{ size: "S", count: 2 }, { size: "M", count: 6 }],
      },
    ],
  },
  {
    orderId: "900002",
    visualId: 900002,
    orderType: "invoice",
    nickname: "Synthetic Event Staff",
    customerCompany: "Harness Community Center",
    contactName: "Jordan Browser",
    statusName: "Production - In Progress",
    invoiceAt: "2026-04-03T12:00:00.000Z",
    productionDueAt: "2026-04-22T12:00:00.000Z",
    customerDueAt: "2026-04-25T12:00:00.000Z",
    detailSyncedAt: "2026-04-04T12:00:00.000Z",
    lineItems: [
      {
        id: "900021",
        itemNumber: "NL3600",
        color: "Royal",
        description: "Synthetic volunteer tee",
        brand: "Next Level",
        categoryName: "Apparel",
        items: 10,
        price: 8.75,
        sizes: [{ size: "L", count: 6 }, { size: "XL", count: 4 }],
      },
      {
        id: "900022",
        itemNumber: null,
        color: "Natural",
        description: "Synthetic unnumbered tote",
        brand: "Manual Test Brand",
        categoryName: "Bags",
        items: 4,
        price: 5,
        sizes: [],
      },
      {
        id: "900023",
        itemNumber: "C112",
        color: "Graphite",
        description: "Synthetic staff cap",
        brand: "Port Authority",
        categoryName: "Headwear",
        items: 6,
        price: 12,
        sizes: [{ size: "OSFA", count: 6 }],
      },
    ],
  },
];

const allowedModes = new Set(["all-success", "mixed", "network-failure"]);
let mode = "all-success";
let queue = structuredClone(fixtureOrders);
let recordedRequests = [];

function queueResponse() {
  const orders = queue.filter((order) => order.lineItems.length > 0);
  const lineItems = orders.flatMap((order) => order.lineItems);
  return {
    orders,
    totalOrders: orders.length,
    totalLineItems: lineItems.length,
    totalPieces: lineItems.reduce((sum, item) => sum + item.items, 0),
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendText(response, status, contentType, body) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("Request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function isSelection(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.lineItemId === "string" &&
      value.lineItemId.length > 0 &&
      typeof value.orderId === "string" &&
      value.orderId.length > 0,
  );
}

function removeUpdated(results) {
  const ids = new Set(
    results.filter((result) => result.outcome === "updated").map((result) => result.lineItemId),
  );
  queue = queue
    .map((order) => ({
      ...order,
      lineItems: order.lineItems.filter((item) => !ids.has(item.id)),
    }))
    .filter((order) => order.lineItems.length > 0);
}

function mutationResponse(lineItems) {
  const results = lineItems.map((selection, index) => {
    let outcome = "updated";
    if (mode === "mixed" && index === 1) outcome = "conflict";
    if (mode === "mixed" && index === 2) outcome = "unknown";
    const messages = {
      updated: "Synthetic status update accepted",
      conflict: "Synthetic conflict: line no longer needs ordering",
      unknown: "Synthetic upstream result was unknown",
    };
    return { ...selection, outcome, message: messages[outcome] };
  });
  removeUpdated(results);
  return {
    results,
    updated: results.filter((result) => result.outcome === "updated").length,
    alreadySet: 0,
    failed: results.filter((result) => result.outcome !== "updated").length,
  };
}

async function findHubCss() {
  const assetsDir = join(HUB_DIR, "dist", "public", "assets");
  const names = await readdir(assetsDir);
  const css = names.filter((name) => /^index-.*\.css$/.test(name)).sort().at(-1);
  if (!css) throw new Error(`No compiled Hub CSS found in ${assetsDir}`);
  return readFile(join(assetsDir, css));
}

const harnessHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Purchasing Bulk Cleanup Browser Harness</title>
    <link rel="stylesheet" href="/hub.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/bundle.mjs"></script>
  </body>
</html>`;

async function main() {
  await buildHarness();
  if (process.argv.includes("--build-only")) {
    console.log(`Harness bundle built at ${BUNDLE_PATH}`);
    return;
  }

  const [bundle, hubCss] = await Promise.all([
    readFile(BUNDLE_PATH),
    findHubCss(),
  ]);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
      const path = url.pathname;

      if (request.method === "GET" && path === "/") {
        sendText(response, 200, "text/html; charset=utf-8", harnessHtml);
        return;
      }
      if (request.method === "GET" && path === "/bundle.mjs") {
        sendText(response, 200, "text/javascript; charset=utf-8", bundle);
        return;
      }
      if (request.method === "GET" && path === "/hub.css") {
        sendText(response, 200, "text/css; charset=utf-8", hubCss);
        return;
      }
      if (request.method === "GET" && path === "/api/purchasing/needs-ordering") {
        sendJson(response, 200, queueResponse());
        return;
      }
      if (request.method === "GET" && path === "/__test/state") {
        sendJson(response, 200, {
          mode,
          recordedRequests,
          queue: queueResponse(),
          queueLineItemIds: queue.flatMap((order) => order.lineItems.map((item) => item.id)),
        });
        return;
      }
      if (request.method === "POST" && path === "/__test/reset") {
        const body = await readJsonBody(request);
        const nextMode = body.mode ?? "all-success";
        if (!allowedModes.has(nextMode)) {
          sendJson(response, 400, {
            error: `mode must be one of: ${[...allowedModes].join(", ")}`,
          });
          return;
        }
        mode = nextMode;
        queue = structuredClone(fixtureOrders);
        recordedRequests = [];
        sendJson(response, 200, { ok: true, mode, queue: queueResponse() });
        return;
      }
      if (
        request.method === "POST" &&
        path === "/api/purchasing/line-item-product-status"
      ) {
        const body = await readJsonBody(request);
        recordedRequests.push({
          sequence: recordedRequests.length + 1,
          method: request.method,
          path,
          body,
        });
        if (
          !Array.isArray(body.lineItems) ||
          body.lineItems.length < 1 ||
          body.lineItems.length > 5 ||
          !body.lineItems.every(isSelection) ||
          !["unset", "ordered", "received"].includes(body.status)
        ) {
          sendJson(response, 400, {
            error: "Expected 1-5 lineItems and status unset, ordered, or received",
          });
          return;
        }
        if (mode === "network-failure") {
          sendJson(response, 503, { error: "Synthetic network failure" });
          return;
        }
        sendJson(response, 200, mutationResponse(body.lineItems));
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, {
          error: "Write rejected by isolated browser harness",
        });
        return;
      }
      sendJson(response, 404, { error: "Not found in isolated browser harness" });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid request",
      });
    }
  });

  server.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`Purchasing browser harness listening on http://${HOST}:${PORT}`);
    console.log("No requests are proxied; all non-harness writes are rejected.");
  });

  const close = () => server.close(() => void rm(BUNDLE_PATH, { force: true }));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

await main();