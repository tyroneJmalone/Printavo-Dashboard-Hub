import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { build } from "esbuild";
const outfile = `${import.meta.dirname}/.internal-invoice-policy.test.mjs`;
try {
  await build({
    entryPoints: ["tests/internalInvoicePolicy.test.ts"],
    absWorkingDir: import.meta.dirname,
    outfile, bundle: true, platform: "node", format: "esm", packages: "external",
  });
  process.exitCode = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" }).status ?? 1;
} finally {
  rmSync(outfile, { force: true });
}