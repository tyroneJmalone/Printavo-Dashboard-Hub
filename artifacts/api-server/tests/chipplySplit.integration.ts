import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { getChipplyDataDetail, reviewChipplySplit, type SplitRequest } from "../src/lib/chipply/dataService";
import { loadChipplyReport } from "../src/lib/reports/chipplyLoader";
import { chipplyReportCsv } from "../src/lib/reports/chipplyData";

test("isolated DB split review: preview, persistence, concurrency, stale evidence, revoke and snapshot changes", async () => {
  // These minimal tables live ONLY in a random isolated schema set by the runner.
  // No public rows, defaults, sequences, Printavo services or real staff accounts.
  try {
    await pool.query(`
      CREATE TABLE chipply_stores(id uuid PRIMARY KEY,store_name text,event_id text,organization_name text,org_contact text,closed_at date);
      CREATE TABLE chipply_data_snapshots(id uuid PRIMARY KEY,store_id uuid,source_hash text,source_name text,payload jsonb,actor text,created_at timestamptz DEFAULT now());
      CREATE TABLE chipply_data_current(store_id uuid PRIMARY KEY,snapshot_id uuid,updated_at timestamptz DEFAULT now());
      CREATE TABLE chipply_data_overrides(id uuid DEFAULT gen_random_uuid(),snapshot_id uuid,row_ordinal integer,invoice_id text,reason text,actor text,created_at timestamptz DEFAULT now());
      CREATE TABLE chipply_data_split_reviews(id uuid DEFAULT gen_random_uuid(),snapshot_id uuid,process_key text,invoice_ids jsonb,evidence_hash text,action text,reason text,actor text,created_at timestamptz DEFAULT now());
      CREATE TABLE pv_orders(printavo_id text PRIMARY KEY,visual_id integer,nickname text,status_name text,detail_sync_state text,detail_synced_at timestamptz,printavo_updated_at timestamptz,order_type text,customer_company text,contact_name text);
      CREATE TABLE pv_line_items(order_id text,item_number text,color text,items integer,sizes jsonb);
    `);
    const storeId = randomUUID(), snapshotId = randomUUID();
    await pool.query("INSERT INTO chipply_stores(id,store_name,event_id) VALUES($1,'Fixture','999999')", [storeId]);
    const payload = { salesOrder: "999999", sourceHash: "fixture", storeName: "Fixture", summary: { quantity: 3 },
      lines: [{ rowOrdinal: 1, orderNumber: "1", orderDate: "2026-01-01", plannedMethod: "screenprint", style: "S1", color: "Navy", size: "M", quantity: 3, processName: "PRINT: Front", itemTotalCents: 300 }] };
    await pool.query(`INSERT INTO chipply_data_snapshots(id,store_id,payload) VALUES($1,$2,$3);
    `, [snapshotId, storeId, JSON.stringify(payload)]);
    await pool.query("INSERT INTO chipply_data_current(store_id,snapshot_id) VALUES($1,$2)", [storeId, snapshotId]);
    for (const [id, qty] of [["a", 1], ["b", 2]] as const) {
      await pool.query(`INSERT INTO pv_orders VALUES($1,22251,'999999 Fixture PRINT: Front','PRINT','complete','2026-01-02','2026-01-01','invoice',NULL,NULL)`, [id]);
      await pool.query(`INSERT INTO pv_line_items VALUES($1,'S1','Navy',$2,$3)`, [id, qty, JSON.stringify([{ size: "M", count: qty }])]);
    }
    const request: SplitRequest = { snapshotId, processKey: "front", invoiceIds: ["a", "b"], action: "preview", revision: null };
    const detail = () => getChipplyDataDetail(storeId);
    const initial = (await detail())!;
    assert.equal(initial.lines[0].reconciliation.outcome, "ambiguous");
    const preview = await reviewChipplySplit(storeId, request, "fixture-reviewer");
    assert.equal(preview.eligible, true);
    assert.equal((await detail())!.splitHistory.length, 0, "Preview must not write a review");
    await assert.rejects(reviewChipplySplit(storeId, { ...request, action: "approve", reason: "Intentional split", evidence: "bad" }, "fixture-reviewer"), /Evidence changed/);
    const approve = { ...request, action: "approve" as const, reason: "Intentional split verified", evidence: preview.evidence };
    const concurrent = await Promise.allSettled([
      reviewChipplySplit(storeId, approve, "fixture-a"), reviewChipplySplit(storeId, approve, "fixture-b"),
    ]);
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
    let current = (await detail())!;
    assert.equal(current.splitHistory.length, 1);
    assert.equal(current.lines[0].reconciliation.actualMethod, "screenprint");
    assert.equal(current.lines[0].reconciliation.splitInvoices?.length, 2);
    assert.equal(current.lines[0].itemTotalCents, 300, "Dollars are never doubled");
    const activeReport = await loadChipplyReport({});
    assert.equal(activeReport.lines.length, 1, "Split invoices never multiply source report rows");
    assert.equal(activeReport.lines[0].actualMethod, "screenprint");
    assert.equal(activeReport.lines[0].invoiceId, null, "Do not invent a single invoice for the set");
    assert.equal(activeReport.summary.itemTotalCents, 300);
    assert.equal(activeReport.summary.unallocatedItemTotalCents, 0);
    assert.equal((await loadChipplyReport({ actualMethod: "screenprint" })).lines.length, 1);
    assert.equal((await loadChipplyReport({ actualMethod: "Unallocated" })).lines.length, 0);
    assert.doesNotMatch(chipplyReportCsv(activeReport.lines), /Unallocated/);
    const revision = current.processComparisons[0].splitRevision;
    await assert.rejects(reviewChipplySplit(storeId, approve, "fixture-reviewer"), /Another review/);
    await pool.query("UPDATE pv_orders SET status_name='EMB' WHERE printavo_id='b'");
    current = (await detail())!;
    assert.equal(current.processComparisons[0].splitReview?.state, "stale");
    assert.equal(current.lines[0].reconciliation.actualMethod, null);
    const staleReport = await loadChipplyReport({});
    assert.equal(staleReport.lines[0].actualMethod, null);
    assert.equal(staleReport.summary.unallocatedItemTotalCents, 300);
    assert.equal((await loadChipplyReport({ actualMethod: "screenprint" })).lines.length, 0);
    assert.match(chipplyReportCsv(staleReport.lines), /Unallocated/);
    const stale = await reviewChipplySplit(storeId, { ...request, revision }, "fixture-reviewer");
    assert.equal(stale.eligible, false);
    await reviewChipplySplit(storeId, { ...request, revision, action: "revoke", reason: "Source changed; remove split" }, "fixture-reviewer");
    assert.equal((await detail())!.lines[0].reconciliation.outcome, "ambiguous");
    assert.equal((await detail())!.splitHistory.length, 2);
    const revokedReport = await loadChipplyReport({ actualMethod: "Unallocated" });
    assert.equal(revokedReport.lines.length, 1);
    assert.equal(revokedReport.lines[0].actualMethod, null);
    assert.equal(revokedReport.summary.itemTotalCents, 300);
    assert.equal(revokedReport.summary.unallocatedItemTotalCents, 300);
    assert.match(chipplyReportCsv(revokedReport.lines), /Unallocated/);
    await pool.query("UPDATE pv_orders SET status_name='PRINT' WHERE printavo_id='b'");
    const revokedRevision = (await detail())!.processComparisons[0].splitRevision;
    const next = await reviewChipplySplit(storeId, { ...request, revision: revokedRevision }, "fixture-reviewer");
    await pool.query("UPDATE pv_orders SET printavo_updated_at='2026-01-03' WHERE printavo_id='b'");
    await assert.rejects(reviewChipplySplit(storeId, { ...approve, revision: revokedRevision, evidence: next.evidence }, "fixture-reviewer"), /Evidence changed/);
    await pool.query("UPDATE chipply_data_current SET snapshot_id=$1", [randomUUID()]);
    await assert.rejects(reviewChipplySplit(storeId, request, "fixture-reviewer"), /Snapshot changed/);
  } finally { await pool.end(); }
});
