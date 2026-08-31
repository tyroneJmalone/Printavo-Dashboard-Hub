import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/writer-lock.test.mjs";

await build({
  entryPoints: ["tests/writerLock.test.ts"],
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

// NODE_ENV=production keeps the bundled logger off the pino-pretty dev
// transport, which is not resolvable from the /tmp bundle.
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", outfile], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
process.exit(result.status ?? 1);
