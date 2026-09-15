import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { rm } from "node:fs/promises";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Refusing DB-backed knowledge integration tests outside a development process");
}

const outfile = `${import.meta.dirname}/.tmp-context-knowledge.integration.test.mjs`;

await build({
  entryPoints: ["tests/contextKnowledge.integration.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["express", "pino", "pino-pretty", "thread-stream"],
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