import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/knowledge-categories.test.mjs";
await build({
  entryPoints: ["tests/knowledgeCategories.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  plugins: [{
    name: "offline-db",
    setup(build) {
      build.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "offline-db", namespace: "offline" }));
      build.onResolve({ filter: /^@workspace\/integrations-openai-ai-server$/ }, () => ({
        path: "offline-openai", namespace: "offline",
      }));
      build.onLoad({ filter: /.*/, namespace: "offline" }, () => ({
        contents: "export const appSettingsTable = {}; export const db = {}; export const openai = {};",
        loader: "js",
      }));
    },
  }],
});
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", outfile], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);