import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/dashboard-metrics.test.mjs";
await build({
  entryPoints: ["tests/dashboardMetrics.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const result = spawnSync(process.execPath, ["--test", outfile], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgres://unused:unused@localhost/unused" },
});
process.exit(result.status ?? 1);