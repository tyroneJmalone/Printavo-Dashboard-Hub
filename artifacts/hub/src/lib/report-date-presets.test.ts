import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_DATE_PRESETS, reportDateRange } from "./report-date-presets";

test("all ten presets use exact Eastern calendar ranges", () => {
  const now = new Date("2026-10-03T16:00:00Z");
  const expected = [
    ["2026-10-03", "2026-10-03"], ["2026-10-02", "2026-10-02"],
    ["2026-09-28", "2026-10-03"], ["2026-09-21", "2026-09-27"],
    ["2026-10-01", "2026-10-03"], ["2026-09-01", "2026-09-30"],
    ["2026-10-01", "2026-10-03"], ["2026-07-01", "2026-09-30"],
    ["2026-01-01", "2026-10-03"], ["2025-01-01", "2025-12-31"],
  ];
  REPORT_DATE_PRESETS.forEach(([id], i) => assert.deepEqual(reportDateRange(id, now), { start: expected[i][0], end: expected[i][1] }));
});
test("handles year rollover, leap February, DST, and Eastern midnight", () => {
  assert.deepEqual(reportDateRange("lq", new Date("2026-01-01T12:00Z")), { start: "2025-10-01", end: "2025-12-31" });
  assert.deepEqual(reportDateRange("lm", new Date("2024-03-01T12:00Z")), { start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(reportDateRange("today", new Date("2026-01-01T02:00Z")), { start: "2025-12-31", end: "2025-12-31" });
  assert.deepEqual(reportDateRange("yesterday", new Date("2026-03-09T05:00Z")), { start: "2026-03-08", end: "2026-03-08" });
  assert.deepEqual(reportDateRange("wtd", new Date("2026-11-01T17:00Z")), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(reportDateRange("wtd", new Date("2026-01-05T17:00Z")), { start: "2026-01-05", end: "2026-01-05" });
});