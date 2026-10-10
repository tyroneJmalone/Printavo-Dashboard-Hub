import { spawnSync } from "node:child_process";
import { build } from "esbuild";
const outfile = "/tmp/knowledge-library.test.mjs";
await build({
  entryPoints: ["tests/knowledgeLibrary.test.ts"], absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);
