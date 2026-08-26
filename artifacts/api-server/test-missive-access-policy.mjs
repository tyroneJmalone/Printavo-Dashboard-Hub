import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/missive-access-policy.test.mjs";

await build({
  entryPoints: ["tests/missiveAccessPolicy.test.ts"],
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