import { test } from "node:test";
import assert from "node:assert/strict";
import { isInternalReplacementInvoice, poAttachmentTargets } from "../src/lib/purchasing/internalInvoicePolicy";

test("replacement invoice matches its visual number, not unrelated or missing IDs", () => {
  assert.equal(isInternalReplacementInvoice(22787), true);
  assert.equal(isInternalReplacementInvoice("22787"), true);
  for (const value of [null, undefined, "", 22788]) assert.equal(isInternalReplacementInvoice(value), false);
});

test("mixed POs retain every line but attach only to eligible customer invoices", () => {
  const lines = [
    { printavoOrderId: "internal", visualId: 22787, status: "done" },
    { printavoOrderId: "customer", visualId: 22800, status: "done" },
    { printavoOrderId: "customer", visualId: 22800, status: "skipped_ordered" },
    { printavoOrderId: "failed", visualId: 22801, status: "failed" },
  ];
  const before = JSON.stringify(lines);
  assert.deepEqual([...poAttachmentTargets(lines, [], [])], [["customer", 22800]]);
  assert.equal(JSON.stringify(lines), before);
  assert.equal(poAttachmentTargets(lines, ["customer"], []).size, 0);
});

test("mirror resolves legacy snapshot numbers and exclusions cover duplicate lines on retries", () => {
  const legacy = [{ printavoOrderId: "internal", visualId: null, status: "skipped_ordered" }];
  assert.equal(poAttachmentTargets(legacy, [], [{ id: "internal", visualId: 22787 }]).size, 0);
  assert.equal(poAttachmentTargets([
    ...legacy, { printavoOrderId: "internal", visualId: 22787, status: "failed" },
  ], [], []).size, 0);
});