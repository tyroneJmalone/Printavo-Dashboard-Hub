import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";

globalThis.require = createRequire(import.meta.url);
const outfile = "/tmp/pantone-verification-integration.test.mjs";
await build({
  entryPoints: ["tests/pantoneVerification.integration.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["*.node", "pg-native"],
  banner: {
    js: `import { createRequire as __createRequire } from 'node:module';
globalThis.require = __createRequire(import.meta.url);`,
  },
});
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);