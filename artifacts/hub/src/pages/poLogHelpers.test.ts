import test from "node:test";
import assert from "node:assert/strict";
import { partitionPoLog } from "./poLogHelpers.ts";

test("PO Log history requires both vendor submission and a completed Printavo push", () => {
  const lockedAfterPrintavoPush = {
    id: "push-locked",
    submittedToVendorAt: null,
    pushedToPrintavoAt: "2026-07-10T12:00:00.000Z",
    locked: true,
    pushState: { status: "success" },
  };
  const unknownVendorAttempt = {
    id: "unknown",
    submittedToVendorAt: null,
    locked: false,
    vendorAttempt: "unknown",
  };
  const submitted = {
    id: "submitted",
    submittedToVendorAt: "2026-07-10T12:00:00.000Z",
    locked: true,
  };
  const completed = {
    ...submitted,
    id: "completed",
    pushedToPrintavoAt: "2026-07-10T12:05:00.000Z",
    pushState: { status: "success" },
  };
  const failed = { ...completed, id: "failed-retry", pushState: { status: "failed" } };
  const running = { ...completed, id: "running-retry", pushState: { status: "running" } };

  const result = partitionPoLog([
    lockedAfterPrintavoPush,
    unknownVendorAttempt,
    submitted,
    completed,
    failed,
    running,
  ]);

  assert.deepEqual(result.pending.map((po) => po.id), [
    "push-locked", "unknown", "submitted", "failed-retry", "running-retry",
  ]);
  assert.deepEqual(result.history.map((po) => po.id), ["completed"]);
});