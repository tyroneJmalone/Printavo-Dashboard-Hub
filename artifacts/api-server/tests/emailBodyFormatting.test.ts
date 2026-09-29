import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, readableMessageBody } from "../src/lib/emailActivity/gmail";
import { segmentEmailBody } from "../../hub/src/components/email/emailBodySegments";

test("HTML email retains paragraphs, signature rows, lists and quotes without active content", () => {
  const text = htmlToText('<style>.secret{}</style><script>alert(1)</script><p>Hello!</p><div>First line<br><br>Second line</div><table><tr><td>Mint Printworks</td><td>Sales</td></tr><tr><td>Contact us</td></tr></table><ul><li>Shirts</li><li>Hats</li></ul><blockquote><div>Earlier message</div></blockquote><img src="https://example.test/pixel">');
  assert.match(text, /Hello!\n\nFirst line\n\nSecond line/);
  assert.match(text, /Mint Printworks\tSales\nContact us/);
  assert.match(text, /• Shirts\n• Hats/);
  assert.match(text, /> Earlier message/);
  assert.doesNotMatch(text, /alert|secret|pixel|<img/);
});

test("entity decoding, quoted attributes, and preformatted text remain readable", () => {
  assert.equal(htmlToText('<div title="a > b">A &amp; B &#x1F44D; &#8212; &quot;OK&quot;</div>'), 'A & B 👍 — "OK"');
  assert.equal(htmlToText('<pre>one\n  two</pre>'), "one\n  two");
  assert.equal(htmlToText('&lt;script&gt;literal&lt;/script&gt;'), "<script>literal</script>");
});

const part = (mimeType: string, text: string) => ({ mimeType, body: { data: Buffer.from(text).toString("base64url") } });
test("MIME selection retains native plain text, recovers flat alternatives and keeps size cap", () => {
  assert.equal(readableMessageBody({ parts: [part("text/plain", "Hello\n\nNative"), part("text/html", "<p>Alternative</p>")] }), "Hello\n\nNative");
  assert.equal(readableMessageBody({ parts: [part("text/plain", "Hello Native"), part("text/html", "<div>Hello</div><div>Native</div>")] }), "Hello\nNative");
  assert.equal(readableMessageBody(part("text/plain", "x".repeat(13_000))).length, 12_000);
  assert.equal(readableMessageBody(undefined), "");
});

test("signature and repeated reply headers become separate sections without losing any source text", () => {
  const body = "Hello,\r\n\r\nThe shirts are ready.\r\n\r\nThanks,\r\nAlex\r\nMint Printworks\r\n\r\nOn Tue, Sep 29, 2026, Sam wrote:\r\n> Earlier message\r\n\r\n-----Original Message-----\r\nOldest message";
  const segments = segmentEmailBody(body);
  assert.deepEqual(segments.map(s => s.kind), ["message", "signature", "quote", "quote"]);
  assert.equal(segments.map(s => s.text).join(""), body);
});

test("Outlook headers and explicit signatures are recognized, ordinary prose is not guessed", () => {
  const body = "Hello\n-- \nName\nFrom: Someone\nSent: Tuesday\nTo: Team\nSubject: Order\nOld reply";
  assert.deepEqual(segmentEmailBody(body).map(s => s.kind), ["message", "signature", "quote"]);
  const prose = "We wrote: some text\nFrom: our warehouse\nThanks for your help with Mint Printworks.";
  assert.deepEqual(segmentEmailBody(prose), [{ kind: "message", text: prose }]);
  const original = "New reply\n-----Original Message-----\n\nFrom: Someone\nSent: Tuesday\nTo: Team\nSubject: Order\nOld reply";
  assert.deepEqual(segmentEmailBody(original).map(s => s.kind), ["message", "quote"]);
  assert.equal(segmentEmailBody(original).map(s => s.text).join(""), original);
});