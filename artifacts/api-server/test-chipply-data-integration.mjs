import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
if (process.env.NODE_ENV !== "development" || process.env.CHIPPLY_DEV_INTEGRATION !== "authorized") {
  throw new Error("Requires NODE_ENV=development CHIPPLY_DEV_INTEGRATION=authorized; never run against production");
}
const outfile = new URL("./.chipply-data.integration.cjs", import.meta.url).pathname;
await build({
  entryPoints: ["tests/chipplyData.integration.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "development-pool-only", setup(b) {
    b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "development" }));
    b.onLoad({ filter: /.*/, namespace: "development" }, () => ({ loader: "js", contents:
      `import {createRequire} from 'node:module'; const {Pool}=createRequire(process.cwd()+'/../../lib/db/package.json')('pg'); export const pool=new Pool({connectionString:process.env.DATABASE_URL});` }));
  } }],
});
try {
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: import.meta.dirname, env: process.env });
  process.exitCode = result.status ?? 1;
} finally { await rm(outfile, { force: true }); }