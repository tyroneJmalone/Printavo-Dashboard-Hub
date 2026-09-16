import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = `${import.meta.dirname}/.auto-print-decoration.test.mjs`;

await build({
  entryPoints: ["tests/autoPrintDecoration.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);