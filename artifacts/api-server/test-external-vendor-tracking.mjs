import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
const outfile = "/tmp/external-vendor-tracking.test.mjs";
try {
  await build({entryPoints:[`${import.meta.dirname}/tests/externalVendorTracking.test.ts`],outfile,bundle:true,platform:"node",format:"esm"});
  process.exitCode = spawnSync(process.execPath,["--test",outfile],{stdio:"inherit"}).status ?? 1;
} finally { rmSync(outfile,{force:true}); }
