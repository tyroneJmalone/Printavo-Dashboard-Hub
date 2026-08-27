import { spawnSync } from "node:child_process";
import { build } from "esbuild";
const outfile = "/tmp/palette-suggestions.test.mjs";
await build({ entryPoints: ["tests/paletteSuggestions.test.ts"], absWorkingDir: import.meta.dirname, outfile, bundle: true, platform: "node", format: "esm", sourcemap: "inline" });
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);