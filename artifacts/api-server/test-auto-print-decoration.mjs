import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "autoprint-decoration-"));
const outfile = path.join(dir, "test.mjs");

await build({
  entryPoints: ["tests/autoPrintDecoration.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 1);