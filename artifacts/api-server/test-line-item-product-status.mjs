import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outfile = new URL("./.line-item-product-status.test.mjs", import.meta.url).pathname;

await build({
  entryPoints: ["tests/lineItemProductStatus.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["pino"],
  plugins: [{
    name: "mock-production-io",
    setup(build) {
      build.onResolve({ filter: /^@workspace\/db$/ }, () => ({
        path: "db",
        namespace: "mock-io",
      }));
      build.onResolve({ filter: /printavoGateway|\/sync\/detail$/ }, (args) => ({
        path: args.path.includes("detail") ? "detail" : "gateway",
        namespace: "mock-io",
      }));
      build.onLoad({ filter: /.*/, namespace: "mock-io" }, (args) => ({
        loader: "js",
        contents: args.path === "db"
          ? "export const db={}; export const changeEventsTable={}; export const pvLineItemsTable={}; export const pvOrdersTable={};"
          : args.path === "detail"
            ? "export const newDetailAgg=()=>({}); export const refreshOrderDetail=async()=>{};"
            : "export const getPrintavoClient=()=>{throw new Error('production gateway disabled in mock test')};",
      }));
    },
  }],
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
await rm(outfile, { force: true });
process.exit(result.status ?? 1);