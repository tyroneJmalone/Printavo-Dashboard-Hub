import assert from "node:assert/strict";
import test from "node:test";
import { opportunitySchema, stages, threadLinkSchema } from "./validation";

test("prelaunch opportunity needs no customer, email, event or fabricated store", () => {
  const opportunity = opportunitySchema.parse({ name: "Staff-created prospective store" });
  assert.equal(opportunity.chipplyStoreId, null);
  assert.equal(opportunity.eventId, null);
  assert.equal(opportunity.stage, "Target/Prospect/Inquiry");
  for (const stage of stages) assert.ok(opportunitySchema.safeParse({ name: "Store", stage }).success);
});
test("calendar dates, money, stage and unknown fields are strictly validated", () => {
  for (const data of [
    { name: "Store", stage: "fake" },
    { name: "Store", dueDate: "2026-02-30" },
    { name: "Store", details: { checkAmount: "-20" } },
    { name: "Store", details: { checkAmount: "2.999" } },
    { name: "Store", details: { websiteUrl: "javascript:alert(1)" } },
    { name: "Store", customerEmail: "not-required@example.com" },
  ]) assert.equal(opportunitySchema.safeParse(data).success, false);
  assert.ok(opportunitySchema.safeParse({ name: "Store", dueDate: "2028-02-29", details: { checkAmount: "0.01" } }).success);
});
test("links require explicit confirmation and exactly one validated thread reference", () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  assert.ok(threadLinkSchema.safeParse({ confirmed: true, threadId }).success);
  assert.equal(threadLinkSchema.safeParse({ threadId }).success, false);
  assert.equal(threadLinkSchema.safeParse({ confirmed: true, manualUrl: "https://example.com/thread" }).success, false);
  const manualUrl = `https://mail.missiveapp.com/#inbox/${threadId}`;
  assert.ok(threadLinkSchema.safeParse({ confirmed: true, manualUrl }).success);
  assert.equal(threadLinkSchema.safeParse({ confirmed: true, manualUrl, threadId }).success, false);
});