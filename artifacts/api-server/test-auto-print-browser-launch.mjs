import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { build } from "esbuild";

const outfile = `${import.meta.dirname}/.auto-print-browser-launch.test.mjs`;

await build({
  entryPoints: ["tests/autoPrintBrowserLaunch.test.ts"],
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
rmSync(outfile, { force: true });
process.exit(result.status ?? 1);