import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { db, draftPatternEventsTable } from "@workspace/db";
import { like } from "drizzle-orm";
import {
  receivePatternWebhook,
  verifyMissiveSignature,
  webhookDedupeKey,
} from "../src/lib/draftPatterns/service";

// Payload deliberately has NO tracked mailbox, so the async pipeline fails
// fast without ever calling Missive. Pattern C never writes on this input.
function payload(convoId: string, messageId?: string) {
  return {
    rule: { id: "r-test", description: "dedupe test" },
    conversation: { id: convoId, subject: "dedupe test" },
    message: {
      ...(messageId ? { id: messageId } : {}),
      from_field: { address: "customer@example.com", name: "Test" },
      to_fields: [{ address: "untracked@example.com", name: "Nobody" }],
      preview: "test",
    },
  };
}

test("signature verification accepts valid HMAC and rejects tampering", () => {
  const secret = "test-secret";
  const body = Buffer.from(JSON.stringify(payload("test-dedupe-sig")));
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.ok(verifyMissiveSignature(body, sig, secret));
  assert.ok(!verifyMissiveSignature(Buffer.concat([body, Buffer.from(" ")]), sig, secret));
  assert.ok(!verifyMissiveSignature(body, sig, "other-secret"));
  assert.ok(!verifyMissiveSignature(body, undefined, secret));
});

test("an identical signed delivery is accepted once and ignored on replay", async () => {
  const p = payload(`test-dedupe-${Date.now()}`);
  const raw = Buffer.from(JSON.stringify(p));
  const first = await receivePatternWebhook("C", p, raw);
  assert.equal(first.accepted, true);
  assert.ok(first.eventId);
  const replay = await receivePatternWebhook("C", p, raw);
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, "duplicate delivery");
  assert.equal(replay.eventId, null);
});

test("dedupe keys prefer the provider message id over the body hash", () => {
  const withId = payload("c1", "missive-msg-1");
  assert.equal(webhookDedupeKey(withId, "body-a"), "msg:missive-msg-1");
  assert.equal(webhookDedupeKey(withId, "different-body"), "msg:missive-msg-1");
  const noId = payload("c1");
  assert.equal(webhookDedupeKey(noId, "body-a"), webhookDedupeKey(noId, "body-a"));
  assert.notEqual(webhookDedupeKey(noId, "body-a"), webhookDedupeKey(noId, "body-b"));
});

test.after(async () => {
  await db
    .delete(draftPatternEventsTable)
    .where(like(draftPatternEventsTable.providerConversationId, "test-dedupe-%"));
});
