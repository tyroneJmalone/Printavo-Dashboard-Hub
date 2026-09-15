import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import path from "node:path";

const outfile = `${import.meta.dirname}/.auto-print-live-discovery.test.mjs`;

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
process.exit(result.status ?? 1);