import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/pipeline-enhancements.test.mjs";
await build({
  entryPoints: ["tests/pipelineEnhancements.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...process.argv.slice(2), outfile], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
process.exit(result.status ?? 1);