import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import assert from "node:assert/strict";
const outfile = new URL("./.chipply-categories.test.mjs", import.meta.url).pathname;
const buildResult = await build({
  entryPoints: ["tests/chipplyCategories.test.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "esm", metafile: true,
  plugins: [{
    name: "no-external-io",
    setup(build) {
      build.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "offline" }));
      build.onResolve({ filter: /printavoGateway$/ }, () => ({ path: "gateway", namespace: "offline" }));
      build.onResolve({ filter: /\/sync\/detail$/ }, () => ({ path: "detail", namespace: "offline" }));
      build.onLoad({ filter: /.*/, namespace: "offline" }, args => ({
        loader: "js",
        contents: args.path === "db"
          ? "export const pool={query:(...a)=>globalThis.fixture.query(...a),connect:async()=>({query:(...a)=>globalThis.fixture.query(...a),release:()=>{}})};"
          : args.path === "detail"
            ? "export const newDetailAgg=()=>({}); export const refreshOrderDetail=(...a)=>globalThis.fixture.refresh(...a);"
            : "export const getPrintavoClient=()=>globalThis.fixture.client;",
      }));
    },
  }],
});
// Prove the tested service has fixture-backed dependencies, not the production
// DB/gateway/detail modules. A missed plugin match fails before tests can run.
const inputs = Object.keys(buildResult.metafile.inputs);
for (const name of ["db", "gateway", "detail"]) assert(inputs.includes(`offline:${name}`));
assert(!inputs.some(path => /lib\/db\/src\/index|printavoGateway\.ts|sync\/detail\.ts/.test(path)));
console.log("Verified bundle: DB, Printavo gateway, and detail refresh all replaced with offline fixtures.");
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", env: { PATH: process.env.PATH } });
await rm(outfile, { force: true });
process.exit(result.status ?? 1);