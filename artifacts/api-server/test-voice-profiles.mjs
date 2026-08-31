import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/voice-profiles.harness.mjs";

await build({
  entryPoints: ["tests/voiceProfiles.harness.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

const result = spawnSync(process.execPath, ["--enable-source-maps", outfile], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
