import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outfile = `${import.meta.dirname}/.tmp-knowledge-base.integration.test.mjs`;

await build({
  entryPoints: ["tests/knowledgeBase.integration.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["express"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});

const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", outfile], {
  stdio: "inherit",
});
await rm(outfile, { force: true });
process.exit(result.status ?? 1);