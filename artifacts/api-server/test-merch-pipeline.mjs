import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
const outfile = new URL("./.merch-pipeline.test.cjs", import.meta.url).pathname;
await build({
  entryPoints: ["tests/merchPipeline.test.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "offline-merch-dependencies", setup(b) {
    b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "offline" }));
    b.onResolve({ filter: /^@workspace\/integrations-openai-ai-server$/ }, () => ({ path: "openai", namespace: "offline" }));
    b.onResolve({ filter: /lib\/missive\/sync$/ }, () => ({ path: "sync", namespace: "offline" }));
    b.onLoad({ filter: /.*/, namespace: "offline" }, ({ path }) => ({
      loader: "js", resolveDir: import.meta.dirname,
      contents: path === "db"
        ? `export * from "../../lib/db/src/schema/merchPipeline.ts"; export * from "../../lib/db/src/schema/staffUsers.ts"; export * from "../../lib/db/src/schema/chipplyStores.ts"; export const pool={query:(...args)=>globalThis.merchTestPool(...args)}; export const db=new Proxy({}, {get:(_,key)=>(...args)=>globalThis.merchTestDb[key](...args)});`
        : path === "openai" ? "export const openai={};" : "export const runMissiveSync=()=>{throw Error('External sync forbidden in offline tests')};",
    }));
  } }],
});
try {
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: import.meta.dirname });
  process.exitCode = result.status ?? 1;
} finally { await rm(outfile, { force: true }); }