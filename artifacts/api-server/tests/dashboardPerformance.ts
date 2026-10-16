import { pool } from "@workspace/db";
import { DASHBOARD_SQL } from "../src/lib/hub/dashboardMetrics";
import { dashboardDetailsSql, PERFORMANCE_METRICS } from "../src/lib/hub/dashboardDetails";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";

// Read-only, one repeatable snapshot; never starts the server or its schedulers.
const runs = Number(process.argv[2] ?? 5);
const output = resolve(process.argv[3] ?? "../../generated-artifacts/dashboard-performance");
const baseline = process.argv[4] ? resolve(process.argv[4]) : null;
if (baseline === output) throw new Error("Candidate output must differ from baseline directory");
if (!Number.isInteger(runs) || runs < 3 || runs > 20) throw new Error("Use 3–20 measured runs");
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const counts = (await client.query(`SELECT
    (SELECT count(*) FROM pv_orders) AS orders,
    (SELECT count(*) FROM change_events) AS events,
    (SELECT count(*) FROM pv_line_items) AS lines,
    (SELECT count(*) FROM pv_payments) AS payments,
    (SELECT count(*) FROM pv_customers) AS customers`)).rows[0];
  const indexes = (await client.query(`SELECT tablename, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN
    ('pv_orders','change_events','pv_line_items','pv_imprints','pv_payments','pv_customers')
    ORDER BY tablename, indexname`)).rows;
  const cases = [
    { name: "aggregate", sql: DASHBOARD_SQL, params: [] as unknown[] },
    ...PERFORMANCE_METRICS.flatMap(metric => ["today", "ytd", "ly"].map(period => ({
      name: `${metric}-${period}`, sql: dashboardDetailsSql(metric), params: [period, 50, 0],
    }))),
  ];
  await mkdir(output, { recursive: true });
  const summaries = [];
  const baselineReport = baseline
    ? JSON.parse(await readFile(resolve(baseline, "summary.json"), "utf8")) : null;
  const regressions: string[] = [];
  for (const item of cases) {
    await writeFile(resolve(output, `${item.name}.sql`), item.sql);
    if (baseline) {
      const previous = await readFile(resolve(baseline, `${item.name}.sql`), "utf8");
      assert.deepEqual((await client.query(item.sql, item.params)).rows,
        (await client.query(previous, item.params)).rows, `${item.name} result parity`);
    }
    const samples = [];
    let last;
    for (let i = 0; i <= runs; i++) {
      const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`, item.params);
      last = result.rows[0]["QUERY PLAN"][0];
      if (i > 0) samples.push(last["Execution Time"]);
    }
    samples.sort((a, b) => a - b);
    const summary = { name: item.name, samplesMs: samples,
      medianMs: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.ceil(samples.length * .95) - 1] };
    summaries.push(summary);
    if (baselineReport) {
      const prior = baselineReport.summaries.find((entry: { name: string }) => entry.name === item.name);
      if (!prior) throw new Error(`Missing baseline measurement: ${item.name}`);
      // Relative tolerance plus a small absolute allowance for fast queries.
      if (summary.medianMs > prior.medianMs * 1.25 + 25) regressions.push(item.name);
    }
    console.log(JSON.stringify(summary));
    await writeFile(resolve(output, `${item.name}.json`), JSON.stringify(last, null, 2));
  }
  await writeFile(resolve(output, "summary.json"), JSON.stringify({
    measuredAt: new Date().toISOString(), counts, indexes, runs,
    warmups: 1, summaries, regressions,
  }, null, 2));
  console.log(JSON.stringify({ counts, output }));
  assert.deepEqual(regressions, [], "Median regression exceeds baseline × 1.25 + 25ms; inspect plans and rerun under comparable load");
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
