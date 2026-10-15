import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
if (process.env.REPLIT_DEPLOYMENT || process.env.NODE_ENV === "production") throw new Error("Development-only fixtures");
const outfile = new URL("../../lib/db/.sales-test.mjs", import.meta.url).pathname;
await build({
  entryPoints: ["tests/sales.test.ts"], absWorkingDir: import.meta.dirname, outfile,
  bundle: true, platform: "node", format: "esm", packages: "external", external: ["pg"],
  plugins: [{ name: "fixture-db", setup(b) {
    b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "fixture", namespace: "sales" }));
    b.onLoad({ filter: /.*/, namespace: "sales" }, () => ({
      contents: `import pg from "pg"; export const pool=new pg.Pool({connectionString:process.env.DATABASE_URL, options:"-c search_path="+process.env.SALES_TEST_SCHEMA});`,
      loader: "js",
    }));
  } }],
});
const result = spawnSync(process.execPath, ["--test", outfile], {
  stdio: "inherit",
  env: { ...process.env, SALES_TEST_SCHEMA: `sales_test_${Date.now()}`, SALES_DDL: `${import.meta.dirname}/scripts/sales-tables.sql` },
});
rmSync(outfile, { force: true });
process.exit(result.status ?? 1);
