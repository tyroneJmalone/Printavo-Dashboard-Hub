import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
const outfile = new URL("../hub/.chipply-comparison.test.mjs", import.meta.url).pathname;
try {
  await build({ entryPoints: ["../hub/src/components/chipply/ProcessComparison.test.tsx"], absWorkingDir: import.meta.dirname,
    outfile, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic" });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: import.meta.dirname });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outfile, { force: true });
}
