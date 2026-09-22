import { build } from "esbuild";
import { spawnSync } from "node:child_process";
const outfile = "/tmp/printscope.test.mjs";
await build({ entryPoints: ["tests/printscope.test.ts"], absWorkingDir: import.meta.dirname, outfile, bundle: true, platform: "node", format: "esm", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
process.exit(result.status ?? 1);