import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const outputDir = mkdtempSync(path.join(tmpdir(), "auto-print-discovery-"));
const outfile = path.join(outputDir, "test.mjs");

try {
await build({
  entryPoints: ["tests/autoPrintLiveDiscovery.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  packages: "external",
  alias: {
    "@workspace/printavo": path.resolve(
      import.meta.dirname,
      "../../lib/printavo/src/index.ts",
    ),
  },
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}