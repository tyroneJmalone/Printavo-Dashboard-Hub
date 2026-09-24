import test from "node:test";
import assert from "node:assert/strict";
import { partitionPoLog } from "./poLogHelpers.ts";

test("PO Log history requires a positively recorded vendor submission", () => {
  const lockedAfterPrintavoPush = {
    id: "push-locked",
    submittedToVendorAt: null,
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

  const result = partitionPoLog([
    lockedAfterPrintavoPush,
    unknownVendorAttempt,
    submitted,
  ]);

  assert.deepEqual(result.pending.map((po) => po.id), ["push-locked", "unknown"]);
  assert.deepEqual(result.history.map((po) => po.id), ["submitted"]);
});