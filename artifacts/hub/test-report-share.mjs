import assert from "node:assert/strict";
import { reportShare } from "./src/lib/report-share.ts";

assert.equal(reportShare(25, 100), 25);
assert.equal(reportShare(45, 300), 15);
assert.equal(reportShare(0, 100), 0);
assert.equal(reportShare(0, 0), 0);
assert.equal(reportShare(5, 0), 0);
assert.equal(reportShare(NaN, 100), 0);
assert.equal(reportShare(5, Infinity), 0);
assert.equal(reportShare(1, 3).toFixed(1), "33.3");
// Two overlapping groups each contain 75 of the same 100 filtered orders.
// They must not each become 50% by dividing by the summed row counts.
assert.equal(reportShare(75, 100), 75);
console.log("PASS report shares: filtered denominator, overlaps, rounding and empty totals");
