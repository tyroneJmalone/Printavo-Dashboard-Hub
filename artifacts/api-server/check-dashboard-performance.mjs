import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "dashboard-perf-"));
try {
  const outfile = join(dir, "check.mjs");
  await build({
    entryPoints: ["tests/dashboardPerformance.ts"],
    absWorkingDir: import.meta.dirname, outfile, bundle: true,
    platform: "node", format: "esm",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, NODE_ENV: "production" },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
