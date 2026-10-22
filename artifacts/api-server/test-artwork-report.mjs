import { spawnSync } from "node:child_process";
import { build } from "esbuild";
const outfile = "/tmp/artwork-report.test.mjs";
await build({ entryPoints: ["tests/artworkReport.test.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "esm", packages: "external" });
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);
