import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/knowledge-merge.test.mjs";

await build({
  entryPoints: ["tests/knowledgeMerge.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
});

const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", outfile], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);