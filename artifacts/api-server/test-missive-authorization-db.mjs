import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const outdir = "/tmp/missive-authorization-db-test";
const outfile = `${outdir}/missive-authorization-db.test.mjs`;

await build({
  entryPoints: {
    "missive-authorization-db.test": "tests/missiveAuthorizationDb.test.ts",
  },
  absWorkingDir: import.meta.dirname,
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["*.node", "pg-native", "lightningcss", "sharp"],
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);`,
  },
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);