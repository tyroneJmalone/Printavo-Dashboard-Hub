import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/report-activity.test.mjs";

await build({
  entryPoints: ["tests/reportActivity.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  packages: "external",
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);