import { build } from "esbuild";
import { spawnSync } from "node:child_process";
const outfile = "/tmp/autoprint-alerts.test.mjs";
await build({
  stdin: { contents: 'import "./tests/autoPrintAlerts.test.ts"; import "./tests/autoPrintAlertCursor.test.ts";', resolveDir: import.meta.dirname, loader: "ts" }, absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [{ name: "block-live-services", setup(build) {
    build.onResolve({ filter: /(?:printavoGateway|\/pdf|\/printNode|\/statusJobs|\/hubPoBatch)$/ }, () => {
      throw new Error("Notification tests must not import any print or upstream mutation service");
    });
  } }],
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit",
  env: { ...process.env, DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/no_live_database" } });
process.exit(result.status ?? 1);
