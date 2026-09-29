import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const outputDir = mkdtempSync(path.join(tmpdir(), "auto-print-hub-po-batch-"));
const outfile = path.join(outputDir, "test.mjs");
await build({
  entryPoints: ["tests/autoPrintHubPoBatch.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  // Production DB/PO loaders are lazy and never used in these offline tests.
  // Keep their dependency graphs out of the bundle (which otherwise hoists
  // external imports from lazily initialized modules).
  plugins: [{
    name: "offline-hub-po-boundaries",
    setup(build) {
      build.onResolve({ filter: /purchasing\/poFiles$/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  }],
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
rmSync(outputDir, { recursive: true, force: true });
process.exit(result.status ?? 1);