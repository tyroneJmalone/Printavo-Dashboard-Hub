import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/draft-backtest.harness.mjs";

await build({
  entryPoints: ["tests/draftBacktest.harness.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

const result = spawnSync(process.execPath, ["--enable-source-maps", outfile, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
