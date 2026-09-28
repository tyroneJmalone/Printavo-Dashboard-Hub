import assert from "node:assert/strict";
import { test } from "node:test";
import { periodBounds, periodRanges, DASHBOARD_SQL, getDashboardMetrics } from "../src/lib/hub/dashboardMetrics";

test("Eastern calendar starts are Monday, quarter and year; DST does not shift dates", () => {
  assert.deepEqual(periodBounds("2026-01-01"), {
    today: "2026-01-01", wtd: "2025-12-29", lw: "2025-12-22", mtd: "2026-01-01",
    qtd: "2026-01-01", ytd: "2026-01-01",
  });
  assert.deepEqual(periodBounds("2026-04-01"), {
    today: "2026-04-01", wtd: "2026-03-30", lw: "2026-03-23", mtd: "2026-04-01",
    qtd: "2026-04-01", ytd: "2026-01-01",
  });
  assert.equal(periodBounds("2026-03-08").wtd, "2026-03-02");
  assert.equal(periodBounds("2026-11-01").wtd, "2026-10-26");
  assert.throws(() => periodBounds("2026-02-30"));
  assert.deepEqual(periodRanges("2026-01-01").lw, { start: "2025-12-22", end: "2025-12-28" });
  assert.deepEqual(periodRanges("2026-03-09").lw, { start: "2026-03-02", end: "2026-03-08" });
  assert.deepEqual(periodRanges("2026-11-02").lw, { start: "2026-10-26", end: "2026-11-01" });
});

test("SQL retains separate populations, complete-detail quantity, status history and shell filters", () => {
  assert.match(DASHBOARD_SQL, /PARTITION BY customer_id ORDER BY printavo_created_at, visual_id/);
  assert.match(DASHBOARD_SQL, /coalesce\(o\.status_name, ''\) !~\* '\(archive\|duplicat\|reference\)'/);
  assert.match(DASHBOARD_SQL, /DISTINCT ON \(customer_id, visual_id\)/);
  assert.match(DASHBOARD_SQL, /detail_sync_state = 'complete'/);
  assert.match(DASHBOARD_SQL, /e\.event_type = 'status_change'/);
  assert.match(DASHBOARD_SQL, /NOT IN \('won', 'done'\)/);
  assert.match(DASHBOARD_SQL, /o\.order_type = 'quote'/);
  assert.match(DASHBOARD_SQL, /transaction_date BETWEEN/);
  assert.match(DASHBOARD_SQL, /o\.close_stage IN \('won', 'done'\)/);
  assert.match(DASHBOARD_SQL, /WHEN quotes = 0 THEN NULL/);
});

test("read-only dev smoke: helper aggregate shape, counts and elapsed time", {
  skip: process.env.DASHBOARD_READONLY_SMOKE !== "1" ? "opt in with DASHBOARD_READONLY_SMOKE=1" : false,
}, async () => {
  const started = performance.now();
  const result = await getDashboardMetrics();
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(result.timeZone, "America/New_York");
  assert.ok(result.periods.today.totalOrders >= 0);
  assert.ok(result.recent.quotesCreated.total >= result.recent.quotesCreated.items.length);
  assert.ok(result.recent.dealsWon.total >= result.recent.dealsWon.items.length);
  console.log(JSON.stringify({
    elapsedMs, asOf: result.asOf, todayOrders: result.periods.today.totalOrders,
    ytdOrders: result.periods.ytd.totalOrders,
    recentQuotes: result.recent.quotesCreated.total,
    recentWon: result.recent.dealsWon.total,
  }));
});

// Only run with an explicit opt-in: all fixture tables are TEMP and every
// statement executes in one transaction on one connection, then ROLLBACK.
test("isolated PostgreSQL fixture: repeat events, conversions, method overlap, won transitions", {
  skip: process.env.DASHBOARD_PG_FIXTURE !== "1" ? "opt in with DASHBOARD_PG_FIXTURE=1" : false,
}, async () => {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["pv_orders", "pv_customers", "pv_line_items", "pv_imprints", "pv_payments", "change_events"]) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    }
    // LIKE INCLUDING DEFAULTS otherwise inherits the public event sequence;
    // nextval is not rolled back, even though every fixture row is temporary.
    await client.query("CREATE TEMP SEQUENCE dashboard_fixture_event_id");
    await client.query("ALTER TABLE pg_temp.change_events ALTER COLUMN id SET DEFAULT nextval('pg_temp.dashboard_fixture_event_id')");
    const today = (await client.query(
      "SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS today",
    )).rows[0].today as string;
    const instant = `${today} 12:00:00 America/New_York`;
    const insertOrder = async (id: string, visual: number, customer: string, type: string,
      status = "Quote", total = 100, nickname = "Normal") => {
      await client.query(`INSERT INTO pv_orders
        (printavo_id, visual_id, customer_id, order_type, status_name, nickname,
         total, printavo_created_at, detail_sync_state, data, content_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,'complete','{}','fixture')`,
      [id, visual, customer, type, status, nickname, total, instant]);
    };
    await insertOrder("q1", 101, "returning", "quote");
    await insertOrder("i1", 101, "returning", "invoice"); // converted identity, not a second repeat
    await insertOrder("q2", 102, "returning", "quote");
    await insertOrder("i2", 103, "returning", "invoice", "Ready to Go", 200);
    await insertOrder("x1", 104, "returning", "quote", "ARCHIVED");
    await insertOrder("x2", 105, "returning", "invoice", "DUPLICATED");
    await insertOrder("x3", 106, "returning", "quote", "REFERENCE");
    await insertOrder("shell", 107, "returning", "invoice", "Quote", 999, "123456 Store HEAT:");
    await insertOrder("first", 201, "fresh", "invoice");
    await client.query(`INSERT INTO pv_line_items
      (printavo_id, order_id, group_id, items, category_name) VALUES
      ('li1','i2','g1',10,' Screen   Printing '),
      ('li2','i2','g1',5,'Embroidery'),
      ('li3','i2','g2',2,'Heat Applied Graphics'),
      ('blank','i2','g3',25,'Blank Goods'),
      ('imprinted','i2','g4',3,'Unclassified'),
      ('zero','first','g5',0,'Unclassified')`);
    await client.query(`INSERT INTO pv_imprints (printavo_id, order_id, group_id) VALUES
      ('imp1','i2','g1'), ('imp2','i2','g1'), ('imp3','i2','g4')`);
    // Quote/invoice transition histories are attached to the currently mirrored id.
    await client.query(`INSERT INTO change_events (entity_type, entity_id, event_type,
      old_value, new_value, occurred_at) VALUES
      ('order','i2','status_change','"Quote"','"Ready to Go"',$1::timestamptz),
      ('order','i2','status_change','"Ready to Go"','"Complete"',$1::timestamptz),
      ('order','first','status_change','"Quote"','"Follow Up 1"',$1::timestamptz)`, [instant]);
    await client.query(`INSERT INTO change_events (entity_type, entity_id, visual_id, event_type,
      old_value, new_value, occurred_at) VALUES
      ('order','q-old',201,'status_change','"Quote"','"Complete"',$1::timestamptz),
      ('order','first',201,'converted','{"printavoId":"q-old","orderType":"quote"}',
       '{"printavoId":"first","orderType":"invoice"}',$1::timestamptz)`, [instant]);
    const row = (await client.query(DASHBOARD_SQL)).rows[0];
    assert.equal(row.periods.today.totalOrders, 4); // excluded repeat statuses still count in base invoice totals
    assert.equal(row.periods.today.totalRevenue, 500);
    assert.equal(row.periods.today.repeatCustomers, 2); // q2 and i2, not conversion i1
    assert.equal(row.periods.today.itemsDecorated, 20); // 15+2+3 decorated, no blank goods, no imprint fanout
    assert.equal(row.averages.today.all.quantityKnownOrders, 2); // zero-line order is known; absent detail is not
    assert.equal(row.averages.today.all.averageOrderVolume, 22.5); // (15+2+25+3+0)/2
    assert.equal(row.averages.today.print.orders, 1);
    assert.equal(row.averages.today.embroidery.orders, 1);
    assert.equal(row.averages.today.heat.orders, 1);
    assert.equal(row.averages.today.print.averageOrderValue, 200);
    assert.equal(row.recent.dealsWon.total, 2); // done followup not another win; converted quote resolved
    assert.equal(row.recent.quotesCreated.total, 4); // q1, q2, x1, x3 (recent lists not repeat-qualified)
    await client.query("UPDATE pv_orders SET detail_sync_state = 'incomplete' WHERE printavo_id = 'x2'");
    const incomplete = (await client.query(DASHBOARD_SQL)).rows[0];
    assert.equal(incomplete.periods.today.itemsDecorated, null);
    assert.equal(row.close_rate.today.percentage, 20); // one won invoice / five eligible logical orders
    assert.equal(row.close_rate.lw.percentage, null); // zero denominator
    assert.equal(row.activity.lw.quotesCreated.total, 0);

    // Reset temporary fixtures only. Exercise a fixed cross-year reporting day.
    await client.query("TRUNCATE pg_temp.pv_orders, pg_temp.change_events, pg_temp.pv_line_items, pg_temp.pv_imprints, pg_temp.pv_payments, pg_temp.pv_customers");
    const fixedSql = DASHBOARD_SQL.replace(
      "(now() AT TIME ZONE 'America/New_York')::date AS today",
      "'2026-01-01'::date AS today",
    );
    const add = async (id: string, visual: number, type: string, date: string, status = "Quote") => {
      await insertOrder(id, visual, `c${visual}`, type, status);
      await client.query("UPDATE pg_temp.pv_orders SET printavo_created_at = $2::timestamptz WHERE printavo_id = $1", [id, date]);
    };
    await add("open", 301, "quote", "2025-12-23T12:00:00-05:00");
    await add("converted", 302, "invoice", "2026-01-01T12:00:00-05:00");
    const noHistory = (await client.query(fixedSql)).rows[0].close_rate.lw;
    assert.equal(noHistory.quotes, 1);
    assert.equal(noHistory.converted, 0);
    assert.equal(noHistory.percentage, 0); // current eligible quote, genuinely no won invoices
    assert.equal(noHistory.coverageComplete, true);
    assert.match(noHistory.note, /current Printavo createdAt/);
    const event = async (id: string, visual: number, date: string | null) => {
      await client.query(`INSERT INTO pg_temp.change_events
        (entity_type, entity_id, visual_id, event_type, old_value, new_value, occurred_at)
        VALUES ('order',$1,$2,'converted',$3::jsonb,$4::jsonb,'2026-01-01T12:00:00-05:00')`,
      [id, visual, JSON.stringify({ printavoId: `q-${id}`, orderType: "quote",
        quoteHistoryVersion: "1", quoteCreatedAt: date, customerId: `c${visual}` }),
      JSON.stringify({ printavoId: id, orderType: "invoice" })]);
    };
    await event("converted", 302, "2025-12-24T12:00:00-05:00");
    await event("converted", 302, "2025-12-24T12:00:00-05:00"); // repeated evidence, one cohort
    for (const [i, status] of ["mErCh", "cOnTrAcT", "dEaD", "aRcHiVe", "rEfErEnCe"].entries()) {
      await add(`excluded${i}`, 310 + i, "invoice", "2025-12-24T12:00:00-05:00", `In ${status} review`);
      await event(`excluded${i}`, 310 + i, "2025-12-24T12:00:00-05:00");
      await add(`excludedQuote${i}`, 320 + i, "quote", "2025-12-24T12:00:00-05:00", status);
    }
    await add("sunday", 330, "quote", "2025-12-29T04:59:59Z");
    await add("monday", 331, "quote", "2025-12-29T05:00:00Z");
    const cohort = (await client.query(fixedSql)).rows[0];
    assert.equal(cohort.periods.lw.start, "2025-12-22");
    assert.equal(cohort.periods.lw.end, "2025-12-28"); // not today
    assert.equal(cohort.periods.lw.totalOrders, 5); // rate exclusions do not affect base totals
    assert.equal(cohort.averages.lw.all.orders, 5);
    assert.equal(cohort.close_rate.lw.quotes, 2); // open, Sunday; original quote event date is irrelevant
    assert.equal(cohort.close_rate.lw.converted, 0);
    assert.equal(cohort.close_rate.lw.percentage, 0);
    assert.equal(cohort.close_rate.today.percentage, 0);
    assert.equal(cohort.close_rate.lw.coverageComplete, true);
    assert.equal(cohort.activity.lw.quotesCreated.total, 13);
    assert.equal(cohort.activity.lw.quotesCreated.items.length, 12);
    assert.equal(cohort.activity.lw.quotesCreated.truncated, true);
    await event("converted", 302, null); // known dated evidence prevents duplicate unknown poison
    assert.equal((await client.query(fixedSql)).rows[0].close_rate.lw.converted, 0);
    await add("legacy", 340, "invoice", "2026-01-01T12:00:00-05:00");
    await event("legacy", 340, null);
    const unknown = (await client.query(fixedSql)).rows[0];
    assert.equal(unknown.close_rate.lw.percentage, 0);
    assert.equal(unknown.activity.lw.quotesCreated.total, 13);
    // Close Rate is independently computable without any historical events.
    await client.query("TRUNCATE pg_temp.pv_orders, pg_temp.change_events");
    const empty = (await client.query(fixedSql)).rows[0];
    for (const key of ["today", "wtd", "lw", "mtd", "qtd", "ytd"]) {
      assert.deepEqual([empty.close_rate[key].quotes, empty.close_rate[key].converted,
        empty.close_rate[key].percentage, empty.close_rate[key].coverageComplete], [0, 0, null, true]);
    }
    const date = "2026-01-01T12:00:00-05:00";
    await add("won", 500, "invoice", date, "READY   TO GO");
    await add("done", 501, "invoice", date, "Complete");
    await add("won-quote", 502, "quote", date, "Ready to Go");
    await add("done-quote", 503, "quote", date, "Complete");
    await add("art-conflict", 504, "invoice", date, "Art Complete Ready to Go");
    await add("nurture-conflict", 505, "invoice", date, "Nurturing Complete");
    await add("duplicate-conflict", 506, "invoice", date, "Duplicated Complete");
    await add("literal-won", 507, "invoice", date, "Won"); // not a pipeline won status
    await add("same-quote", 500, "quote", "2025-12-24T12:00:00-05:00", "Quote");
    await add("null-one", 508, "invoice", date, "Need 2 Order");
    await add("null-two", 508, "quote", date, "Quote");
    await client.query("UPDATE pg_temp.pv_orders SET customer_id = NULL WHERE visual_id = 508");
    for (const [i, status] of ["mErCh", "cOnTrAcT", "dEaD", "aRcHiVe", "rEfErEnCe"].entries()) {
      await add(`exclude-win-${i}`, 520 + i, "invoice", date, `${status} Complete Ready to Go`);
      await add(`exclude-quote-${i}`, 530 + i, "quote", date, `${status} Quote`);
    }
    await add("shell-won", 540, "invoice", date, "Complete");
    await client.query("UPDATE pg_temp.pv_orders SET nickname = '123456 Store HEAT:' WHERE printavo_id = 'shell-won'");
    const statusRate = (await client.query(fixedSql)).rows[0];
    for (const key of ["today", "wtd", "mtd", "qtd", "ytd"]) {
      assert.equal(statusRate.close_rate[key].quotes, 10);
      assert.equal(statusRate.close_rate[key].converted, 3);
      assert.equal(statusRate.close_rate[key].percentage, 30);
      assert.equal(typeof statusRate.close_rate[key].percentage, "number");
    }
    assert.equal(statusRate.close_rate.lw.percentage, null); // invoice wins identity before date filtering
    for (const boundary of [
      { today: "2026-03-09", start: "2026-03-02", end: "2026-03-08",
        inside: "2026-03-09T03:59:59Z", outside: "2026-03-09T04:00:00Z" },
      { today: "2026-11-02", start: "2026-10-26", end: "2026-11-01",
        inside: "2026-11-02T04:59:59Z", outside: "2026-11-02T05:00:00Z" },
    ]) {
      await client.query("TRUNCATE pg_temp.pv_orders, pg_temp.change_events");
      await add("dst-in", 401, "invoice", boundary.inside, "Complete");
      await add("dst-out", 402, "invoice", boundary.outside, "Ready to Go");
      const dst = (await client.query(DASHBOARD_SQL.replace(
        "(now() AT TIME ZONE 'America/New_York')::date AS today",
        `'${boundary.today}'::date AS today`,
      ))).rows[0];
      assert.equal(dst.periods.lw.start, boundary.start);
      assert.equal(dst.periods.lw.end, boundary.end);
      assert.equal(dst.periods.lw.totalOrders, 1);
      assert.equal(dst.periods.today.totalOrders, 1);
      assert.equal(dst.close_rate.lw.quotes, 1);
      assert.equal(dst.close_rate.lw.converted, 1);
      assert.equal(dst.close_rate.lw.percentage, 100);
      assert.equal(dst.close_rate.today.percentage, 100);
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});