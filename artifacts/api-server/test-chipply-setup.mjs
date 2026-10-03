import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
const outfile = new URL("./.chipply-setup.test.cjs", import.meta.url).pathname;
await build({
  entryPoints: ["tests/chipplySetup.test.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "offline-db", setup(b) {
    b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "offline" }));
    b.onLoad({ filter: /.*/, namespace: "offline" }, () => ({ loader: "js", contents: "export const pool={query:(...a)=>globalThis.chipplyTestQuery(...a),connect:async()=>({query:(...a)=>globalThis.chipplyTestQuery(...a),release:()=>{}})};" }));
  } }],
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: import.meta.dirname });
await rm(outfile, { force: true });
process.exit(result.status ?? 1);