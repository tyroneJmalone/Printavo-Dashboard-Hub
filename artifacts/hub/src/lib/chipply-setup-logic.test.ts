import assert from "node:assert/strict";
import { isComplete, canConfirm, stepSatisfied, nextAttention, syncNotes, toggleConfirmed, factsOk, type SetupState } from "./chipply-setup-logic";

const good = (): SetupState => ({
  confirmedSteps: [],
  marginSkipped: false,
  checks: { storeName: "Fuel Summer", eventId: "553498", customerLinked: true, closedAt: "2026-07-06", invoiceCount: 3, incompleteInvoiceCount: 0, missingCategoryCount: 0, marginRowCount: 0, snapshotId: "snap", orderCount: 41, quantity: 87, itemTotalCents: 231450, outcomes: { matched: 80, reviewed: 7 } },
});

// Facts alone never complete the guide.
let s = good();
assert.equal(isComplete(s), false);
assert.equal(stepSatisfied(7, s), false, "zero missing categories is not correctness");
assert.equal(canConfirm(9, s), false);

// Margins must be imported or explicitly skipped.
s = { ...good(), confirmedSteps: [2, 3, 5, 7] };
assert.equal(factsOk(8, s), false);
assert.equal(canConfirm(9, s), false);
s = { ...s, marginSkipped: true };
assert.equal(canConfirm(9, s), true);
s = { ...s, confirmedSteps: [2, 3, 5, 7, 9] };
assert.equal(isComplete(s), true);

// Unresolved outcomes block completion even with confirmations.
const bad = { ...s, checks: { ...s.checks, outcomes: { matched: 80, ambiguous: 2 } } };
assert.equal(isComplete(bad), false);
assert.equal(nextAttention(1, bad)?.n, 6);

// Notes: keep local edits, adopt teammate edits otherwise.
assert.equal(syncNotes("a", "a", "b"), "b");
assert.equal(syncNotes("mine", "a", "b"), "mine");

assert.deepEqual(toggleConfirmed([7, 2], 3), [2, 3, 7]);
assert.deepEqual(toggleConfirmed([2, 3], 3), [2]);
console.log("chipply-setup-logic: ok");
