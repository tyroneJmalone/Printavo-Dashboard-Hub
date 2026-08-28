import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { canonicalSwatchUrl, cieDe2000, fetchAndMeasureSwatch, measureSwatchBuffer, permittedSwatchUrl, rgbToLab } from "../src/lib/catalog/colorMeasurement";

test("sRGB red converts to D65 Lab", () => {
  const [l, a, b] = rgbToLab([255, 0, 0]);
  assert.ok(Math.abs(l - 53.24) < .02);
  assert.ok(Math.abs(a - 80.09) < .03);
  assert.ok(Math.abs(b - 67.20) < .03);
});
test("CIEDE2000 Sharma reference pair", () => {
  assert.ok(Math.abs(cieDe2000([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < .0002);
});
test("only approved HTTPS swatch hosts are allowed", () => {
  assert.equal(permittedSwatchUrl("https://cdnm.sanmar.com/a.png"), true);
  assert.equal(permittedSwatchUrl("https://www.ssactivewear.com/Images/ColorSwatch/1.jpg"), true);
  assert.equal(permittedSwatchUrl("https://cdn.ssactivewear.com/Images/ColorSwatch/1.jpg"), true);
  assert.equal(canonicalSwatchUrl("https://www.ssactivewear.com/Images/ColorSwatch/1.jpg"), "https://cdn.ssactivewear.com/Images/ColorSwatch/1.jpg");
  assert.equal(permittedSwatchUrl("https://cdn.ssactivewear.com/catalog/1.jpg"), false);
  assert.equal(permittedSwatchUrl("http://cdnm.sanmar.com/a.png"), false);
  assert.equal(permittedSwatchUrl("https://cdnm.sanmar.com.evil.test/a.png"), false);
  assert.equal(permittedSwatchUrl("https://www.ssactivewear.com@evil.test/a.png"), false);
});
test("uniform swatch is measured and a multi-color tile is rejected", async () => {
  const solid = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#123456" } }).png().toBuffer();
  const measured = await measureSwatchBuffer(solid);
  assert.equal(measured.ok, true);
  if (measured.ok) assert.deepEqual(measured.rgb, [18, 52, 86]);
  const raw = Buffer.alloc(40 * 40 * 3);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) raw[(y * 40 + x) * 3] = x < 20 ? 255 : 0;
  const noisy = await sharp(raw, { raw: { width: 40, height: 40, channels: 3 } }).png().toBuffer();
  assert.equal((await measureSwatchBuffer(noisy)).ok, false);
});
test("streamed body without content-length is capped", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); },
  }), { status: 200 })) as typeof fetch;
  try {
    const result = await fetchAndMeasureSwatch("https://cdnm.sanmar.com/swatch.png");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /byte limit/);
  } finally { globalThis.fetch = old; }
});