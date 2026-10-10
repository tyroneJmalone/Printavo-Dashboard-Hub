import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { pool } from "@workspace/db";
import { libraryEligibility, libraryFilters } from "../src/lib/knowledgeLibrary";
import libraryRouter from "../src/routes/knowledgeLibrary";
import express from "express";

after(() => pool.end());

test("library boundaries, search escaping, categories and tag search use isolated fixtures", async () => {
  const client = await pool.connect();
  const dialect = new PgDialect();
  try {
    await client.query("BEGIN");
    // No copied defaults or shared sequences; no persistent rows are touched.
    await client.query(`CREATE TEMP TABLE knowledge_entries (
      id text, title text, body text, category text, tags text[],
      review_status text, effective_date date, expires_date date
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO knowledge_entries VALUES
      ('approved','Refund policy','Return guidelines','policy',ARRAY['handbook'],'approved',NULL,NULL),
      ('draft','Draft secret','Return guidelines','draft-only',ARRAY['private'],'draft',NULL,NULL),
      ('archived','Old policy','Old text','archived-only',ARRAY[]::text[],'archived',NULL,NULL),
      ('future','Next policy','Future text','future-only',ARRAY[]::text[],'approved',CURRENT_DATE+1,NULL),
      ('expired','Expired policy','Expired text','expired-only',ARRAY[]::text[],'approved',NULL,CURRENT_DATE-1),
      ('today','Current policy','Valid today','policy',ARRAY[]::text[],'approved',CURRENT_DATE,CURRENT_DATE),
      ('literal','100%_special','Literal match','training',ARRAY[]::text[],'approved',NULL,NULL)`);
    const query = async (filter: ReturnType<typeof libraryFilters>) => {
      const compiled = dialect.sqlToQuery(filter!);
      const result = await client.query(`SELECT id FROM knowledge_entries WHERE ${compiled.sql} ORDER BY id`, compiled.params);
      return result.rows.map(row => row.id);
    };
    assert.deepEqual(await query(libraryEligibility()), ["approved", "literal", "today"]);
    assert.deepEqual(await query(libraryFilters("handbook")), ["approved"]);
    assert.deepEqual(await query(libraryFilters("guidelines")), ["approved"]);
    assert.deepEqual(await query(libraryFilters(undefined, "policy")), ["approved", "today"]);
    assert.deepEqual(await query(libraryFilters("%_")), ["literal"]);
    assert.deepEqual(await query(libraryFilters("secret")), []);
    assert.deepEqual(await query(libraryFilters(undefined, "draft-only")), []);
    assert.deepEqual(await query(libraryFilters("' OR true --")), []);
    assert.deepEqual(await query(libraryFilters("training")), ["literal"]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("read-only library endpoints paginate, strip source links, and reject invalid/direct draft access", async () => {
  const app = express();
  app.use(libraryRouter); // Isolated local harness. Real application mounts this AFTER staff + module guards.
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/knowledge/library`;
  try {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    const data = await response.json();
    assert.ok(data.items.length <= 30);
    assert.ok(data.total >= data.items.length);
    assert.ok(Array.isArray(data.categories));
    for (const item of data.items) {
      assert.equal(item.reviewStatus, "approved");
      assert.equal(item.sourceUrl, "");
    }
    if (data.items.length) {
      const detail = await (await fetch(`${base}/${data.items[0].id}`)).json();
      assert.equal(detail.id, data.items[0].id);
      assert.equal(detail.body, data.items[0].body);
      assert.equal(detail.sourceUrl, "");
    }
    const draft = await pool.query("SELECT id FROM knowledge_entries WHERE review_status != 'approved' LIMIT 1");
    if (draft.rows.length) assert.equal((await fetch(`${base}/${draft.rows[0].id}`)).status, 404);
    for (const suffix of ["?offset=-1", "?offset=1.5", "?offset=1000001", "/invalid-id"]) {
      assert.equal((await fetch(base + suffix)).status, 400);
    }
    const empty = await (await fetch(base + "?q=__library_missing_8675309__")).json();
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
    assert.deepEqual(empty.categories, data.categories);
    if (data.total > 30) {
      const page2 = await (await fetch(base + "?offset=30")).json();
      assert.ok(page2.items.length > 0);
      assert.ok(!data.items.some((row: {id:string}) => row.id === page2.items[0].id));
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
