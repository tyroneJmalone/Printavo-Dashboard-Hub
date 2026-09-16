import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const outfile = "/tmp/knowledge-tone-recovery-preview.mjs";
const input = process.argv[2];
const mode = process.argv[3] === "--all" ? "--all" : undefined;
if (!input) {
  console.error("Usage: node preview-knowledge-tone-recovery.mjs <extracted-text-file> [--all]");
  process.exit(2);
}

await build({
  entryPoints: ["src/lib/knowledgeTonePreviewCli.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});

const args = ["--enable-source-maps", outfile, input];
if (mode) args.push(mode);
const result = spawn(process.execPath, args, {
  stdio: "inherit",
});
result.on("close", async (code) => {
  await rm(outfile, { force: true });
  process.exit(code ?? 1);
});