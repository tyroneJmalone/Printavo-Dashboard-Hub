import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
if (process.env.NODE_ENV !== "development") throw new Error("Development database only");
const { Pool } = createRequire(new URL("../../lib/db/package.json", import.meta.url))("pg");
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const schema = `chipply_split_test_${randomUUID().replaceAll("-", "")}`;
const outfile = new URL("./.chipply-split.test.cjs", import.meta.url).pathname;
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await build({ entryPoints: ["tests/chipplySplit.integration.ts"], absWorkingDir: import.meta.dirname,
    outfile, bundle: true, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "isolated-fixture-pool", setup(b) {
      b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents:
        `import {createRequire} from 'node:module'; const {Pool}=createRequire(process.cwd()+'/../../lib/db/package.json')('pg'); export const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path=${schema}'});` }));
    } }] });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", cwd: import.meta.dirname });
  process.exitCode = result.status ?? 1;
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  await rm(outfile, { force: true });
}
