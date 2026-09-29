import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID, createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { confirmChipplyData } from "../src/lib/chipply/dataService";
import type { ParsedData } from "../src/lib/chipply/dataImport";

test("development transactions: concurrent confirmation, actor fence, atomic replace, rollback, unique indexes", async () => {
  assert.equal(process.env.NODE_ENV, "development");
  assert.equal(process.env.CHIPPLY_DEV_INTEGRATION, "authorized");
  const runId = randomUUID();
  const actor = `authorized-development-integration:${runId}`;
  const previewIds: string[] = [];
  let storeId: string | undefined;
  let event = "";
  let rollbackEvent = "";
  const fixtureName = `TEMPORARY Chipply integration ${runId}`;
  async function unusedEvent() {
    for (let i = 0; i < 50; i++) {
      const candidate = String(randomInt(9000000, 9999999));
      const found = await pool.query(`SELECT 1 FROM chipply_stores WHERE event_id=$1
        UNION ALL SELECT 1 FROM pv_orders WHERE nickname LIKE $2 LIMIT 1`, [candidate, `${candidate} %`]);
      if (!found.rowCount) return candidate;
    }
    throw new Error("Unable to find unused temporary fixture event");
  }
  function payload(version: string, qty = 1): ParsedData {
    return {
      salesOrder: event, storeName: fixtureName,
      sourceHash: createHash("sha256").update(`${runId}:${version}`).digest("hex"),
      safeHeaders: ["temporary authorized integration fixture"],
      summary: { lineCount: 1, orderCount: 1, quantity: qty, itemTotalCents: qty * 100, orderTotalCents: qty * 100, orderComponentsCents: { "Order Total": qty * 100 }, unitComponentsExtendedCents: { "Item Price": qty * 100 } },
      lines: [{ rowOrdinal: 1, orderNumber: "1", orderDate: "2026-01-01", processName: "PRINT: FRONT: TEST", plannedMethod: "screenprint", style: "TEST", color: "TEST", size: "M", productName: "Temporary test fixture", vendor: "TEST", quantity: qty, itemTotalCents: qty * 100, unitCents: { "Item Price": 100 } }],
      orders: [{ orderNumber: "1", componentsCents: { "Order Total": qty * 100 } }],
    };
  }
  async function preview(data: ParsedData, expected: string | null) {
    const id = randomUUID();
    await pool.query(`INSERT INTO chipply_data_previews(id,actor,source_name,payload,expected_snapshot_id,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes')`, [id, actor, `TEMPORARY-${runId}.csv`, JSON.stringify(data), expected]);
    previewIds.push(id);
    return id;
  }
  async function state() {
    const r = await pool.query(`SELECT c.snapshot_id,s.payload,
      (SELECT count(*)::int FROM chipply_data_snapshots WHERE store_id=$1) snapshots,
      (SELECT count(*)::int FROM chipply_data_events WHERE store_id=$1) events
      FROM chipply_data_current c JOIN chipply_data_snapshots s ON s.id=c.snapshot_id WHERE c.store_id=$1`, [storeId]);
    return r.rows[0];
  }
  try {
    event = await unusedEvent();
    // Reserve exactly one fresh fixture store; event uniqueness protects races.
    const reserved = await pool.query(`INSERT INTO chipply_stores(event_id,store_name)
      VALUES($1,$2) ON CONFLICT(event_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING id`, [event, fixtureName]);
    assert.equal(reserved.rowCount, 1, "Fresh test event unexpectedly claimed; stop without touching it");
    storeId = reserved.rows[0].id;
    const first = await preview(payload("first"), null);
    await assert.rejects(confirmChipplyData(first, `${actor}:wrong-actor`, false), /not found for this staff member/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM chipply_data_snapshots WHERE store_id=$1", [storeId])).rows[0].n, 0);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => confirmChipplyData(first, actor, false)));
    assert.equal(new Set(concurrent.map(r => r.snapshotId)).size, 1);
    assert.equal(concurrent.filter(r => !r.idempotent).length, 1);
    const original = await state();
    assert.equal(original.snapshots, 1);
    assert.equal(original.events, 1);
    const replacementA = await preview(payload("replacement-A", 2), original.snapshot_id);
    const replacementB = await preview(payload("replacement-B", 3), original.snapshot_id);
    await assert.rejects(confirmChipplyData(replacementA, actor, false), /Explicit replaceCurrent/);
    assert.deepEqual(await state(), original);
    const replacements = await Promise.allSettled([
      confirmChipplyData(replacementA, actor, true),
      confirmChipplyData(replacementB, actor, true),
    ]);
    assert.equal(replacements.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(replacements.filter(r => r.status === "rejected").length, 1);
    const replaced = await state();
    assert.notEqual(replaced.snapshot_id, original.snapshot_id);
    assert.equal(replaced.snapshots, 2);
    assert.equal(replaced.events, 2);
    assert.equal(replaced.payload.lines.length, 1, "Replacement must not concatenate old rows");
    assert.deepEqual((await pool.query("SELECT payload FROM chipply_data_snapshots WHERE id=$1", [original.snapshot_id])).rows[0].payload, original.payload);
    await assert.rejects(pool.query("INSERT INTO chipply_stores(event_id,store_name) VALUES($1,$2)", [event, fixtureName]), (e: { code: string }) => e.code === "23505");
    await assert.rejects(pool.query(`INSERT INTO chipply_data_snapshots(store_id,source_hash,source_name,payload,actor)
      SELECT store_id,source_hash,source_name,payload,actor FROM chipply_data_snapshots WHERE id=$1`, [original.snapshot_id]), (e: { code: string }) => e.code === "23505");

    // Force a real DB failure after transactional store upsert: NOT NULL source_hash.
    rollbackEvent = await unusedEvent();
    const broken = { ...payload("rollback"), salesOrder: rollbackEvent, sourceHash: null as unknown as string };
    const failed = await preview(broken, null);
    await assert.rejects(confirmChipplyData(failed, actor, false), (e: { code: string }) => e.code === "23502");
    assert.equal((await pool.query("SELECT count(*)::int n FROM chipply_stores WHERE event_id=$1", [rollbackEvent])).rows[0].n, 0, "Transactional store creation must roll back");
    assert.equal((await pool.query("SELECT confirmed_snapshot_id FROM chipply_data_previews WHERE id=$1", [failed])).rows[0].confirmed_snapshot_id, null);
    assert.deepEqual(await state(), replaced);
  } finally {
    // UUID-only, run-owned cleanup, no customer/mirror rows or sequences touched.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chipply_data_previews WHERE id=ANY($1::uuid[]) AND actor=$2", [previewIds, actor]);
      if (storeId) {
        const own = await client.query("SELECT id FROM chipply_stores WHERE id=$1 AND store_name=$2 AND event_id=$3 FOR UPDATE", [storeId, fixtureName, event]);
        assert.equal(own.rowCount, 1, "Cleanup ownership check failed");
        await client.query("DELETE FROM chipply_data_events WHERE store_id=$1 AND actor=$2", [storeId, actor]);
        await client.query("DELETE FROM chipply_data_current WHERE store_id=$1", [storeId]);
        await client.query("DELETE FROM chipply_data_snapshots WHERE store_id=$1 AND actor=$2", [storeId, actor]);
        await client.query("DELETE FROM chipply_stores WHERE id=$1 AND store_name=$2", [storeId, fixtureName]);
      }
      await client.query("COMMIT");
      assert.equal((await pool.query("SELECT count(*)::int n FROM chipply_data_previews WHERE id=ANY($1::uuid[])", [previewIds])).rows[0].n, 0);
      if (storeId) assert.equal((await pool.query("SELECT count(*)::int n FROM chipply_stores WHERE id=$1", [storeId])).rows[0].n, 0);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); await pool.end(); }
  }
});