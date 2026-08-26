import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/missive-authorization-db.test.cjs";

await build({
  entryPoints: ["tests/missiveAuthorizationDb.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: "inline",
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);