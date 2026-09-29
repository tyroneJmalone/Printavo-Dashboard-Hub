import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { build } from "esbuild";

const outfile = `${import.meta.dirname}/.email-body-formatting.test.mjs`;
try {
  await build({
    entryPoints: ["tests/emailBodyFormatting.test.ts"],
    absWorkingDir: import.meta.dirname,
    outfile, bundle: true, platform: "node", format: "esm", packages: "external",
  });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outfile, { force: true });
}