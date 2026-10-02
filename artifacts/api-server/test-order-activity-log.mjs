import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import path from "node:path";
const outfile = "/tmp/order-activity-log.test.cjs";
await build({
  entryPoints: ["tests/orderActivityLog.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "cjs",
  alias: {
    "@workspace/db": path.join(import.meta.dirname, "tests/orderActivityLogDbFixture.ts"),
    "pg": path.join(import.meta.dirname, "../../lib/db/node_modules/pg/lib/index.js"),
  },
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);