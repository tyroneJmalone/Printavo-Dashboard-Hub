import { build } from "esbuild";
import { spawnSync } from "node:child_process";
const outfile = "/tmp/printscope-retention-integration.mjs";
await build({ entryPoints: ["tests/printscopeRetention.integration.ts"], absWorkingDir: import.meta.dirname, outfile, bundle: true, platform: "node", format: "esm", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const result = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
process.exit(result.status ?? 1);