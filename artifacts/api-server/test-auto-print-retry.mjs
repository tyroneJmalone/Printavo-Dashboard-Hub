import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const outputDir = mkdtempSync(path.join(tmpdir(), "auto-print-retry-"));
const outfile = path.join(outputDir, "test.mjs");
const harness = path.resolve(import.meta.dirname, "tests/autoPrintRetryHarness.ts");
const helper = path.resolve(import.meta.dirname, "src/lib/printQueue/autoPrint/workorderRetry.ts");
const mocks = new Map([
  ["@workspace/db", ["db", "pqPrintRunsTable", "pqPrintJobsTable", "pvOrdersTable", "changeEventsTable", "pvStatusesTable"]],
  ["drizzle-orm", ["eq", "desc", "inArray", "and", "or", "sql"]],
  ["../../sync/upserts", ["upsertOrder"]],
  ["../../sync/detail", ["applyOrderDetail", "newDetailAgg"]],
  ["@workspace/printavo", ["singleOrderDetailQuery"]],
  ["../../printavoGateway", ["getPrintavoClient"]],
  ["./config", ["getAutoPrintConfig"]],
  ["./pdf", ["openPdfRenderer"]],
  ["./printNode", ["printNodeConfigured", "submitPdfPrintJob"]],
  ["../statusJobs", ["startPqStatusJob"]],
  ["./liveDiscovery", ["discoverLiveAutoPrintOrders", "fetchLiveOrderStatus", "LiveDiscoveryError", "liveOrderStatusMatches"]],
  ["./hubPoBatch", ["runHubPoBatch"]],
]);
try {
  await build({
    entryPoints: ["tests/autoPrintRetry.test.ts"], absWorkingDir: import.meta.dirname,
    outfile, bundle: true, platform: "node", format: "esm", packages: "external",
    plugins: [{
      name: "offline-engine-boundaries",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (!args.importer.includes("/src/lib/printQueue/autoPrint/")) return;
          if (mocks.has(args.path)) return { path: args.path, namespace: "offline" };
          if (args.path === "./workorderRetry") return { path: args.path, namespace: "retry-clock" };
        });
        build.onLoad({ filter: /.*/, namespace: "offline" }, (args) => ({
          contents: `export { ${mocks.get(args.path).join(", ")} } from ${JSON.stringify(harness)};`,
          loader: "ts",
          resolveDir: import.meta.dirname,
        }));
        build.onLoad({ filter: /.*/, namespace: "retry-clock" }, () => ({
          contents: `import {runWorkorderAttempts as run} from ${JSON.stringify(helper)};
            import {sleep} from ${JSON.stringify(harness)};
            export {WorkorderSkip} from ${JSON.stringify(helper)};
            export const runWorkorderAttempts = (work, options) => run(work, {...options, sleep});`,
          loader: "ts",
          resolveDir: import.meta.dirname,
        }));
      },
    }],
  });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}