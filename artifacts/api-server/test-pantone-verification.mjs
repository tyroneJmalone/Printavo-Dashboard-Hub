import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/pantone-verification.test.mjs";
await build({
  entryPoints: ["tests/pantoneVerification.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  packages: "external",
});
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);