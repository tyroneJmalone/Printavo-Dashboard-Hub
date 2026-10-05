import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
const outfile = `${import.meta.dirname}/tests/.replacement-slip.test.mjs`;
await build({
  entryPoints: ["tests/replacementSlip.test.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "esm", packages: "external",
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
rmSync(outfile, { force: true });
process.exit(result.status ?? 1);
