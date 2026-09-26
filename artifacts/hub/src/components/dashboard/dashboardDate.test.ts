import assert from "node:assert/strict";
import test from "node:test";
import { formatDashboardDate } from "./dashboardDate";

const md = { month: "short", day: "numeric" } as const;
const mdt = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;

test("date-only strings keep their calendar day", () => {
  assert.equal(formatDashboardDate("2026-01-01", md), "Jan 1");
  assert.equal(formatDashboardDate("2026-03-08", md), "Mar 8");
});

test("UTC instants roll back to the prior Eastern day (EST)", () => {
  assert.equal(formatDashboardDate("2026-01-01T03:30:00Z", md), "Dec 31");
  assert.match(formatDashboardDate("2026-01-01T03:30:00Z", mdt), /Dec 31, 10:30\s?PM/);
});

test("instants respect daylight saving (EDT = UTC-4)", () => {
  assert.match(formatDashboardDate("2026-07-01T03:30:00Z", mdt), /Jun 30, 11:30\s?PM/);
});

test("invalid input returns a dash", () => {
  assert.equal(formatDashboardDate("nope", md), "—");
});
