import assert from "node:assert/strict";
import test from "node:test";
import type { GuardedQueryResult } from "../src/lib/insights/guard.ts";
import {
  buildInsightsAnalysis,
  extractReferencedRelationsFromPlan,
  parseModelAnalysis,
  publicQueryResult,
} from "../src/lib/insights/provenance.ts";

function result(
  partial: Partial<GuardedQueryResult> = {},
): GuardedQueryResult {
  return {
    columns: ["status", "count"],
    rows: [["Art", 4]],
    rowCount: 1,
    truncated: false,
    metadata: {
      referencedRelations: ["change_events"],
      planStatus: "available",
      freshness: {
        status: "known",
        asOf: "2026-07-10T12:00:00.000Z",
        source: "sync_runs.finished_at",
        note: "Latest completed local mirror sync.",
      },
    },
    ...partial,
  };
}

test("findings require valid row, column, and exact supporting value", () => {
  const parsed = parseModelAnalysis(
    JSON.stringify({
      answer: "Four visits.",
      interpretedQuestion: "Count visits.",
      findings: [
        {
          text: "Valid observation",
          evidence: [{ row: 0, column: "count", value: 4 }],
        },
        {
          text: "Wrong value",
          evidence: [{ row: 0, column: "count", value: 5 }],
        },
        {
          text: "Missing row",
          evidence: [{ row: 8, column: "count", value: 4 }],
        },
        {
          text: "Art caused more work",
          evidence: [{ row: 0, column: "status", value: "Art" }],
        },
      ],
    }),
    result(),
  );
  assert.deepEqual(parsed.findings, [
    {
      text: "Valid observation",
      evidence: [{ row: 0, column: "count", value: 4 }],
    },
  ]);
});

test("empty and unavailable summaries remain explicit and usable", () => {
  const query = result({
    columns: ["window_start"],
    rows: [],
    rowCount: 0,
  });
  const analysis = buildInsightsAnalysis("Anything?", query, null);
  assert.equal(analysis.summary.status, "unavailable");
  assert.equal(analysis.summary.sampledRows, 0);
  assert.equal(analysis.dateCoverage.status, "not_measured");
  assert.match(analysis.summary.note ?? "", /successful SQL result remains usable/);
  assert.ok(analysis.limitations.some((item) => /no matching rows/i.test(item)));
  assert.deepEqual(publicQueryResult(query), {
    columns: ["window_start"],
    rows: [],
    rowCount: 0,
    truncated: false,
  });
});

test("sample and row-cap limitations report actual returned evidence", () => {
  const rows = Array.from({ length: 500 }, (_, index) => [
    `2026-07-${String((index % 20) + 1).padStart(2, "0")}`,
    index,
  ]);
  const query = result({
    columns: ["window_start", "count"],
    rows,
    rowCount: 500,
    truncated: true,
  });
  const model = parseModelAnalysis(
    JSON.stringify({ answer: "Sampled.", findings: [] }),
    query,
  );
  const analysis = buildInsightsAnalysis("Trend?", query, model);
  assert.equal(analysis.summary.sampledRows, 50);
  assert.equal(analysis.summary.returnedRows, 500);
  assert.equal(analysis.summary.truncated, true);
  assert.equal(analysis.dateCoverage.status, "measured");
  assert.ok(analysis.limitations.some((item) => /first 50 of 500/i.test(item)));
  assert.ok(analysis.limitations.some((item) => /capped at 500/i.test(item)));
});

test("unrelated created and due dates never become measured coverage", () => {
  const query = result({
    columns: ["created_at", "customer_due_at", "count"],
    rows: [
      ["2025-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z", 4],
    ],
  });
  const analysis = buildInsightsAnalysis("Count?", query, null);
  assert.deepEqual(analysis.dateCoverage, {
    status: "not_measured",
    start: null,
    end: null,
    basis: null,
  });
});

test("deliberate suffixed window aliases measure bounds independently", () => {
  const complete = buildInsightsAnalysis(
    "History?",
    result({
      columns: [
        "observed_entry_window_start",
        "observed_exit_window_end",
      ],
      rows: [["2026-07-08T12:00:00.000Z", "2026-07-10T12:00:00.000Z"]],
    }),
    null,
  );
  assert.equal(complete.dateCoverage.start, "2026-07-08T12:00:00.000Z");
  assert.equal(complete.dateCoverage.end, "2026-07-10T12:00:00.000Z");

  const startOnly = buildInsightsAnalysis(
    "History?",
    result({
      columns: ["observed_entry_window_start"],
      rows: [["2026-07-08T12:00:00.000Z"]],
    }),
    null,
  );
  assert.equal(startOnly.dateCoverage.status, "measured");
  assert.equal(startOnly.dateCoverage.start, "2026-07-08T12:00:00.000Z");
  assert.equal(startOnly.dateCoverage.end, null);
});

test("preset and legacy paths get deterministic evidence without a model", () => {
  const analysis = buildInsightsAnalysis("Saved question", result(), null);
  assert.equal(analysis.interpretedQuestion, "Saved question");
  assert.equal(analysis.summary.status, "unavailable");
  assert.deepEqual(analysis.findings, []);
  assert.deepEqual(analysis.sources.map((item) => item.name), ["change_events"]);
  assert.ok(
    analysis.limitations.some((item) => /only tracked from July 8, 2026/i.test(item)),
  );
  assert.ok(
    analysis.limitations.some((item) => /five-minute polling granularity/i.test(item)),
  );
});

test("source provenance reports plan references, not SQL-looking text", () => {
  const plan = [
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "pv_orders",
        Filter:
          "(nickname = 'change_events JOIN pv_customers') /* never parsed */",
        Plans: [
          {
            "Node Type": "Result",
            "Unused CTE SQL": "SELECT * FROM pv_payments",
          },
        ],
      },
    },
  ];
  assert.deepEqual(
    extractReferencedRelationsFromPlan(plan, [
      "pv_orders",
      "change_events",
      "pv_customers",
      "pv_payments",
    ]),
    ["pv_orders"],
  );
});

test("status-duration result evidence preserves auditable split metrics", () => {
  const query = result({
    columns: [
      "matched_status",
      "completed_visit_count",
      "distinct_invoice_count",
      "average_completed_hours",
      "median_completed_hours",
      "currently_waiting_count",
      "oldest_waiting_hours",
      "window_start",
      "window_end",
    ],
    rows: [
      [
        "🎨 Art Revision Needed",
        12,
        10,
        8.5,
        6.25,
        3,
        22,
        "2026-07-08T12:00:00.000Z",
        "2026-07-10T12:00:00.000Z",
      ],
    ],
    rowCount: 1,
  });
  const output = publicQueryResult(query);
  assert.equal(output.rows[0]?.[1], 12);
  assert.equal(output.rows[0]?.[2], 10);
  assert.equal(output.rows[0]?.[5], 3);
  const analysis = buildInsightsAnalysis("How long in revision?", query, null);
  assert.equal(analysis.dateCoverage.status, "measured");
  assert.match(analysis.dateCoverage.basis ?? "", /timezone.*defined by the SQL/i);
  assert.match(analysis.dateCoverage.basis ?? "", /not independent proof/i);
});

test("findings cannot cite rows omitted from the 50-row model sample", () => {
  const query = result({
    rows: Array.from({ length: 51 }, (_, index) => [`Status ${index}`, index]),
    rowCount: 51,
  });
  const parsed = parseModelAnalysis(
    JSON.stringify({
      answer: "Summary.",
      findings: [
        {
          text: "Hidden row",
          evidence: [{ row: 50, column: "count", value: 50 }],
        },
      ],
    }),
    query,
  );
  assert.deepEqual(parsed.findings, []);
});

test("summary permits user-facing rounding of returned values", () => {
  const monetary = result({
    columns: ["revenue"],
    rows: [[1234.567]],
    rowCount: 1,
  });
  const parsed = parseModelAnalysis(
    JSON.stringify({
      answer: "Revenue was $1,234.57.",
      findings: [],
    }),
    monetary,
  );
  assert.equal(parsed.answer, "Revenue was $1,234.57.");
});