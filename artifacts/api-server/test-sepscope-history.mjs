import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({
  entryPoints: ["../hub/tests/sepscope-history.test.tsx"],
  absWorkingDir: import.meta.dirname,
  jsx: "automatic", bundle: true, platform: "node", format: "esm",
  outfile: "/tmp/sepscope-history-test.mjs",
  banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
});
const result=spawnSync(process.execPath,["--test","/tmp/sepscope-history-test.mjs"],{stdio:"inherit"});
process.exit(result.status??1);
