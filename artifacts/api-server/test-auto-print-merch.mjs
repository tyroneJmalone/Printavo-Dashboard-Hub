import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "autoprint-merch-"));
try {
  const file = path.join(dir, "tests.mjs");
  await build({ entryPoints: ["tests/autoPrintMerch.test.ts"], absWorkingDir: import.meta.dirname, outfile: file, bundle: true, platform: "node", format: "esm" });
  process.exitCode = spawnSync(process.execPath, ["--test", file], { stdio: "inherit" }).status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
