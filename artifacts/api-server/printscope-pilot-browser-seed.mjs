import { build } from "esbuild";
import { spawnSync } from "node:child_process";
const outfile = "/tmp/printscope-pilot-browser-seed.mjs";
await build({ entryPoints: ["tests/printscopePilotBrowserSeed.ts"], absWorkingDir: import.meta.dirname, outfile, bundle: true, platform: "node", format: "esm", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
process.exit(result.status ?? 1);