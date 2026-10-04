import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
if (process.env.NODE_ENV !== "development" || process.env.CHIPPLY_DEV_INTEGRATION !== "authorized") {
  throw new Error("Development-only: NODE_ENV=development CHIPPLY_DEV_INTEGRATION=authorized required");
}
const outfile = new URL("./.chipply-summary.test.cjs", import.meta.url).pathname;
await build({
  entryPoints: ["tests/chipplySummary.test.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "temporary-fixture-db", setup(b) {
    b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "fixtures" }));
    b.onLoad({ filter: /.*/, namespace: "fixtures" }, () => ({ loader: "js", contents:
      "export const pool={query:(...args)=>globalThis.summaryFixtureClient.query(...args),connect:async()=>({query:(...args)=>globalThis.summaryFixtureClient.query(...args),release:()=>{}})};" }));
  } }],
});
try {
  const r = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: import.meta.dirname, env: process.env });
  process.exitCode = r.status ?? 1;
} finally { await rm(outfile, { force: true }); }