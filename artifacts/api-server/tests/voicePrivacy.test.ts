import assert from "node:assert/strict";
import test from "node:test";
import { cleanSentBody, redactSample, sanitizeTraits } from "../src/lib/voice/profiles";

test("redactSample strips emails, links, phones, amounts, and long numbers", () => {
  const input =
    "Hi Sarah, order 22133 for $1,234.50 shipped. Track at https://tracking.example.com/abc?id=99. " +
    "Call me at (555) 123-4567 or reply to sarah.jones@customer-co.com. Ref 4881029.";
  const out = redactSample(input);
  assert.ok(!out.includes("22133"), "order number leaked");
  assert.ok(!out.includes("1,234"), "dollar amount leaked");
  assert.ok(!out.includes("tracking.example.com"), "URL leaked");
  assert.ok(!out.includes("123-4567"), "phone leaked");
  assert.ok(!out.includes("customer-co.com"), "email leaked");
  assert.ok(!out.includes("4881029"), "reference number leaked");
  assert.ok(out.includes("Hi Sarah"), "ordinary prose must survive");
  assert.ok(out.includes("{email}") && out.includes("{amount}") && out.includes("{number}"));
});

test("redactSample leaves short harmless numbers and dates alone", () => {
  const out = redactSample("See you at 3pm on 8/29 — bring the 2 samples.");
  assert.equal(out, "See you at 3pm on 8/29 — bring the 2 samples.");
});

test("cleanSentBody drops quoted history so other people's mail never enters a sample", () => {
  const out = cleanSentBody(
    "Sounds good, I'll get that started today.\n\nOn Mon, Aug 24, 2026 at 9:01 AM Customer <c@x.com> wrote:\n> Can you do 50 shirts?\n> My card is 4111111111111111",
  );
  assert.equal(out, "Sounds good, I'll get that started today.");
});

test("sanitizeTraits drops array items carrying PII and redacts free-text fields", () => {
  const dirty = {
    greetings: ["Hey {firstName},", "Hi sarah@customer-co.com,"],
    signoffs: ["Thanks!", "Call 555-123-4567 anytime"],
    formality: { level: 2, description: "casual, quotes prices like $500 often" },
    messageLength: "short",
    sentenceStyle: "short sentences, mentions order 22133 a lot",
    punctuationHabits: ["exclamation points"],
    emojiUse: "rare",
    phrasingHabits: ["\"I'll get that started\"", "links to https://portal.example.com"],
    toneDescriptors: ["warm"],
    imitationNotes: ["keep it brief"],
  };
  const clean = sanitizeTraits(dirty) as Record<string, any>;
  assert.deepEqual(clean.greetings, ["Hey {firstName},"]);
  assert.deepEqual(clean.signoffs, ["Thanks!"]);
  assert.deepEqual(clean.phrasingHabits, ["\"I'll get that started\""]);
  assert.ok(!clean.formality.description.includes("$500"));
  assert.ok(!clean.sentenceStyle.includes("22133"));
  assert.deepEqual(clean.toneDescriptors, ["warm"]);
  assert.deepEqual(clean.imitationNotes, ["keep it brief"]);
});
