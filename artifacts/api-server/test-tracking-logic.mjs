import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/hub-tracking-logic.test.mjs";
await build({
  entryPoints: ["tests/trackingLogic.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);