import assert from "node:assert/strict";
import test from "node:test";
import { independentTicks } from "../src/lib/printQueue/autoPrint/independentTicks";
import {
  DEFAULT_AUTO_PRINT_CONFIG,
  normalizeAutoPrintConfig,
} from "../src/lib/printQueue/autoPrint/configValidation.ts";
import {
  AUTO_PRINT_CHECK_INTERVAL_MS,
  AUTO_PRINT_TIME_ZONE,
  currentDailySlotKey,
  easternLocalMinute,
  isDailyScheduleDue,
} from "../src/lib/printQueue/autoPrint/scheduleUtils.ts";

test("slow retry crossing a daily slot does not suppress the scheduled tick", async () => {
  let now = new Date("2026-10-05T09:59:00Z");
  let starts = 0, retryStarts = 0;
  let last: Date | null = null;
  let finishRetry!: () => void;
  const slowRetry = new Promise<void>(resolve => { finishRetry = resolve; });
  const tick = independentTicks(async () => {
    if (isDailyScheduleDue(now, ["06:00"], last)) { starts++; last = now; }
  }, async () => { retryStarts++; await slowRetry; }, err => { throw err; });
  tick();
  await new Promise(resolve => setImmediate(resolve));
  now = new Date("2026-10-05T10:00:01Z");
  tick(); // Retry from the previous minute is still running.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(retryStarts, 1);
  now = new Date("2026-10-05T10:01:02Z");
  finishRetry();
  await new Promise(resolve => setImmediate(resolve));
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1, "no catch-up or duplicate daily starts");
});

test("old interval-only configs retain interval behavior and safe daily defaults", () => {
  const normalized = normalizeAutoPrintConfig({
    enabled: true,
    scheduleHours: 4,
    sourceStatusIds: ["source"],
    dryRun: true,
  });

  assert.equal(normalized.scheduleMode, "interval");
  assert.equal(normalized.scheduleHours, 4);
  assert.deepEqual(normalized.dailyTimes, ["06:00"]);
  assert.equal(normalized.dryRun, true);
});

test("daily config normalizes valid unique times and caps at twelve", () => {
  const normalized = normalizeAutoPrintConfig({
    scheduleMode: "daily",
    dailyTimes: [
      "23:59",
      "00:00",
      "12:30",
      "12:30",
      "bad",
      ...Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, "0")}:15`),
    ],
  });

  assert.equal(normalized.scheduleMode, "daily");
  assert.equal(normalized.dailyTimes.length, 12);
  assert.deepEqual(normalized.dailyTimes, [
    "00:00",
    "00:15",
    "01:15",
    "02:15",
    "03:15",
    "04:15",
    "05:15",
    "06:15",
    "07:15",
    "08:15",
    "09:15",
    "10:15",
  ]);
});

test("invalid or missing daily times fall back to 06:00", () => {
  assert.deepEqual(
    normalizeAutoPrintConfig({ scheduleMode: "daily", dailyTimes: ["25:00", "1:00"] })
      .dailyTimes,
    ["06:00"],
  );
  assert.deepEqual(DEFAULT_AUTO_PRINT_CONFIG.dailyTimes, ["06:00"]);
});

test("daily mode supports multiple times and does not catch up an old slot", () => {
  // January is standard time: 06:00 ET = 11:00Z and 12:30 ET = 17:30Z.
  const morning = new Date("2024-01-15T11:00:00.000Z");
  const afternoon = new Date("2024-01-15T17:30:00.000Z");
  assert.equal(currentDailySlotKey(morning, ["06:00", "12:30"]), "2024-01-15T06:00");
  assert.equal(
    isDailyScheduleDue(afternoon, ["06:00", "12:30"], morning),
    true,
  );
  assert.equal(
    isDailyScheduleDue(
      new Date("2024-01-15T17:31:00.000Z"),
      ["06:00", "12:30"],
      morning,
    ),
    false,
  );
  // A check at 12:31 cannot catch up the 12:30 slot.
  assert.equal(currentDailySlotKey(new Date("2024-01-15T17:31:00.000Z"), ["12:30"]), null);
});

test("midnight daily slots use the Eastern calendar date", () => {
  const todayMidnight = new Date("2024-01-15T05:00:00.000Z");
  const yesterdayMidnight = new Date("2024-01-14T05:00:00.000Z");
  assert.equal(easternLocalMinute(todayMidnight).slotKey, "2024-01-15T00:00");
  assert.equal(isDailyScheduleDue(todayMidnight, ["00:00"], yesterdayMidnight), true);
  assert.equal(isDailyScheduleDue(todayMidnight, ["00:00"], todayMidnight), false);
});

test("DST spring-forward skips nonexistent times", () => {
  // 02:30 never occurs on this Eastern date; 07:30Z is 03:30 EDT.
  const springForward = new Date("2024-03-10T07:30:00.000Z");
  assert.equal(easternLocalMinute(springForward).time, "03:30");
  assert.equal(currentDailySlotKey(springForward, ["02:30"]), null);
});

test("DST fall-back repeated local hour is one durable slot", () => {
  // 01:30 occurs at both 05:30Z (EDT) and 06:30Z (EST).
  const firstOccurrence = new Date("2024-11-03T05:30:00.000Z");
  const repeatedOccurrence = new Date("2024-11-03T06:30:00.000Z");
  assert.equal(easternLocalMinute(firstOccurrence).slotKey, "2024-11-03T01:30");
  assert.equal(easternLocalMinute(repeatedOccurrence).slotKey, "2024-11-03T01:30");
  assert.equal(isDailyScheduleDue(firstOccurrence, ["01:30"], null), true);
  assert.equal(isDailyScheduleDue(repeatedOccurrence, ["01:30"], firstOccurrence), false);
});

test("DST fall-back multiple times do not rerun an earlier time", () => {
  const first0130 = new Date("2024-11-03T05:30:00.000Z");
  const first0145 = new Date("2024-11-03T05:45:00.000Z");
  const second0130 = new Date("2024-11-03T06:30:00.000Z");
  const second0145 = new Date("2024-11-03T06:45:00.000Z");

  assert.equal(isDailyScheduleDue(first0130, ["01:30", "01:45"], null), true);
  assert.equal(isDailyScheduleDue(first0145, ["01:30", "01:45"], first0130), true);
  // The latest persisted first-occurrence slot is 01:45, so the repeated
  // 01:30 must not run after a restart or an in-process poll.
  assert.equal(isDailyScheduleDue(second0130, ["01:30", "01:45"], first0145), false);
  assert.equal(isDailyScheduleDue(second0145, ["01:30", "01:45"], first0145), false);
});

test("daily dedup survives restart using the persisted scheduled start", () => {
  const persistedRun = new Date("2024-06-15T10:00:42.000Z");
  const sameMinuteAfterRestart = new Date("2024-06-15T10:00:59.000Z");
  assert.equal(
    isDailyScheduleDue(sameMinuteAfterRestart, ["06:00"], persistedRun),
    false,
  );
  assert.equal(AUTO_PRINT_TIME_ZONE, "America/New_York");
  assert.equal(AUTO_PRINT_CHECK_INTERVAL_MS, 60_000);
});