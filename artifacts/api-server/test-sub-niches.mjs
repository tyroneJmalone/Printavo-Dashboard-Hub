import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
if (process.env.REPLIT_DEPLOYMENT || process.env.NODE_ENV === "production") throw new Error("Development only");
const source = readFileSync(new URL("src/routes/customers.ts", import.meta.url), "utf8");
const insertSql = source.match(/`(INSERT INTO customer_categories \(name, parent_id,[\s\S]*?)`/)[1];
const listSql = source.match(/`(SELECT cc.id, cc.name AS local_name[\s\S]*?)`/)[1];
const assignSql = source.match(/`(SELECT 1 FROM customer_categories cc LEFT JOIN[\s\S]*?)`/)[1];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const c = await pool.connect();
try {
  await c.query("BEGIN");
  const name = `Subniche fixture ${Date.now()}`;
  const parent = (await c.query(insertSql, [name, null])).rows[0];
  const child = (await c.query(insertSql, [`${name} child`, parent.id])).rows[0];
  const listed = (await c.query(listSql)).rows.find(r => r.id === child.id);
  assert.equal(listed.name, `${name} → ${name} child`);
  assert.equal(listed.local_name, `${name} child`);
  assert.equal(listed.parent_id, parent.id);
  assert.equal((await c.query(assignSql, [child.id])).rowCount, 1);
  assert.equal((await c.query(insertSql, [`${name} grandchild`, child.id])).rowCount, 0);
  await c.query("UPDATE customer_categories SET active=false WHERE id=$1", [parent.id]);
  assert.equal((await c.query(assignSql, [child.id])).rowCount, 0);
  assert.equal((await c.query(listSql)).rows.find(r => r.id === child.id).active, false);
  assert.equal((await c.query(insertSql, [`${name} inactive`, parent.id])).rowCount, 0);
  console.log("Sub-niche creation, display paths, depth limit and inactive-parent protections passed (rolled back).");
} finally {
  await c.query("ROLLBACK");
  c.release();
  await pool.end();
}
