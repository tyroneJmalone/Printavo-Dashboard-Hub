import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const outputDir = mkdtempSync(path.join(tmpdir(), "auto-print-engine-boundary-"));
const outfile = path.join(outputDir, "test.mjs");
await build({
  entryPoints: ["tests/autoPrintEngineBoundary.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  alias: { "@workspace/printavo": path.resolve(import.meta.dirname, "../../lib/printavo/src/index.ts") },
  plugins: [{
    name: "offline-po-loader",
    setup(build) {
      build.onResolve({ filter: /purchasing\/poFiles$/ }, (args) => ({ path: args.path, external: true }));
    },
  }],
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
rmSync(outputDir, { recursive: true, force: true });
process.exit(result.status ?? 1);