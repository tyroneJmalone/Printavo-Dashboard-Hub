import assert from "node:assert/strict";
import test from "node:test";
import { canReservePrint, decideReprint, lineItemFingerprint, printAttemptKey, observedSourceMembership, verifiedConversionOrderIds, definitiveFailureCandidates } from "../src/lib/printQueue/autoPrint/candidatePlanning";

const at = new Date("2026-01-01T00:00:00Z");
const after = new Date("2026-01-02T00:00:00Z");
const prior = { contentFingerprint: "old", printedAt: at };
const reentry = { id: 7, occurredAt: after };

test("initial print is permitted without history", () => {
  assert.equal(decideReprint({ prior: null, fingerprint: "new", reentry: null }).allowed, true);
});
test("unchanged, reentry only and line change only do not reprint", () => {
  for (const [fingerprint, entry] of [["old", null], ["old", reentry], ["new", null]] as const) {
    assert.equal(decideReprint({ prior, fingerprint, reentry: entry }).allowed, false);
  }
});
test("changed lines AND a later source reentry print with reprint flag", () => {
  assert.deepEqual(decideReprint({ prior, fingerprint: "new", reentry }), {
    allowed: true, isReprint: true, reason: null, cycle: "entry:7",
  });
  assert.equal(decideReprint({ prior, fingerprint: "new", reentry: { id: 6, occurredAt: at } }).allowed, false);
});
test("legacy baseline missing fails closed explicitly", () => {
  assert.equal(decideReprint({ prior: { ...prior, contentFingerprint: null }, fingerprint: "new", reentry }).reason,
    "prior_print_baseline_missing");
});
test("hash canonicalizes lines and sizes, ignores status and timestamps but detects all product edits", () => {
  const line = { id: "a", itemNumber: "PC54", color: "Red", description: "Shirt", items: 3, price: 10, merch: false,
    sizes: [{ size: "M", count: 1 }, { size: "L", count: 2 }] };
  const other = { id: "b", itemNumber: "PC61", items: 2 };
  const baseline = lineItemFingerprint([line, other]);
  assert.equal(baseline, lineItemFingerprint([other, { ...line, sizes: [...line.sizes].reverse(),
    status: "Ordered", productStatus: "ordered", updatedAt: "tomorrow" }]));
  for (const edit of [{ id: "x" }, { itemNumber: "NEW" }, { color: "Blue" }, { description: "Edited" }, { price: 25 }, { merch: true },
    { items: 4 }, { sizes: [{ size: "M", count: 3 }] }]) {
    assert.notEqual(baseline, lineItemFingerprint([{ ...line, ...edit }, other]));
  }
});

test("status observations support strings, JSON-wrapped strings and known object shapes only", () => {
  const statuses = [{ id: "1", name: "Ordered" }, { id: "2", name: "Processing" }];
  const source = new Set(["1"]);
  for (const value of ["Ordered", '"Ordered"', { name: "Ordered" }, { id: "1" },
    { status: { id: "1", name: "Ordered" } }, { statusId: "1", statusName: "Ordered" }]) {
    assert.equal(observedSourceMembership(value, statuses, source), true);
  }
  for (const value of ["Processing", '"Processing"', { status: "Processing" }, { id: "2" }]) {
    assert.equal(observedSourceMembership(value, statuses, source), false);
  }
  for (const value of [null, {}, [], "unknown", { value: "Ordered" }, { id: "missing", name: "Ordered" },
    { id: "2", name: "Ordered" }, '{"unexpected":true}', 99]) {
    assert.equal(observedSourceMembership(value, statuses, source), null);
  }
});

test("only definitive render/validation failures are error-routing candidates", () => {
  assert.deepEqual(definitiveFailureCandidates([
    { candidate: "render", outcome: "failed", definitivePreSubmitFailure: true },
    { candidate: "unknown", outcome: "failed", definitivePreSubmitFailure: false },
    { candidate: "pending", outcome: "pending", definitivePreSubmitFailure: true },
    { candidate: "accepted", outcome: "printed", definitivePreSubmitFailure: true },
  ]), ["render"]);
});

test("conversion provenance requires exact destination, visual and same customer; ambiguity fails closed", () => {
  const order = { orderId: "invoice", visualId: 100 };
  const conversion = { entityType: "order", eventType: "converted", entityId: "invoice", visualId: 100,
    oldValue: { printavoId: "quote", orderType: "quote", customerId: "customer" },
    newValue: { printavoId: "invoice", orderType: "invoice", customerId: "customer" } };
  assert.deepEqual(verifiedConversionOrderIds(order, [conversion]), ["quote"]);
  assert.deepEqual(verifiedConversionOrderIds(order, [{ ...conversion, visualId: 101 }]), []);
  assert.deepEqual(verifiedConversionOrderIds(order, [{ ...conversion, entityId: "unrelated" }]), []);
  assert.deepEqual(verifiedConversionOrderIds(order, [{ ...conversion,
    oldValue: { ...conversion.oldValue, customerId: "other" } }]), []);
  assert.deepEqual(verifiedConversionOrderIds(order, [conversion, { ...conversion,
    oldValue: { ...conversion.oldValue, printavoId: "other-quote" } }]), []);
});
test("durable logical claim refuses racing winners and ambiguous submissions", () => {
  assert.equal(canReservePrint([], null), true);
  assert.equal(canReservePrint([{ id: "reservation", status: "pending" }], null), false);
  assert.equal(canReservePrint([{ id: "reservation", status: "submission_unknown" }], null), false);
  assert.equal(canReservePrint([{ id: "winner", status: "printed" }], null), false);
  assert.equal(canReservePrint([{ id: "winner", status: "printed" }], "winner"), true);
  assert.equal(printAttemptKey("visual:1", "initial", "abc"), printAttemptKey("visual:1", "initial", "abc"));
  assert.notEqual(printAttemptKey("visual:1", "entry:2", "abc"), printAttemptKey("visual:1", "initial", "abc"));
});