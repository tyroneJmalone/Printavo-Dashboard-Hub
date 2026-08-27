import test from "node:test";
import assert from "node:assert/strict";
import { dedupeStyleInputs, derivePaletteFamilies, rankPaletteColor } from "../src/lib/catalog/paletteSuggestions";

const garment = (colorName: string, families: string[] = []) => ({
  colorName, normName: colorName.toLowerCase(), families, swatchImage: null, productImage: null,
});
const palette = (name: string, role = "primary") => [{ id: "color-1", role, name, hex: null, rgb: null }];

test("exact normalized palette name is highest confidence", () => {
  const hit = rankPaletteColor(garment("Navy Blue", ["blue"]), palette("navy-blue"));
  assert.equal(hit.matchMethod, "exact_name");
  assert.equal(hit.confidence, "high");
  assert.equal(hit.score, 100);
});
test("catalog family overlap matches conservatively", () => {
  const hit = rankPaletteColor(garment("Ocean", ["blue"]), palette("Corporate Blue"));
  assert.equal(hit.matchMethod, "family");
  assert.equal(hit.confidence, "medium");
});
test("unknown names and families remain explicit", () => {
  const hit = rankPaletteColor(garment("Heather Ash"), palette("Corporate Blue"));
  assert.equal(hit.matchMethod, "unknown");
  assert.equal(hit.confidence, "low");
  assert.equal(hit.score, 0);
});
test("palette family derivation accepts valid hex without inventing garment numeric color", () => {
  assert.deepEqual(derivePaletteFamilies({ name: "Brand color", hex: "#001f80", rgb: null }), ["navy"]);
});
test("canonical grey and RGB object parsing use catalog family names", () => {
  assert.deepEqual(derivePaletteFamilies({ name: "Warm Gray", hex: null, rgb: null }), ["grey"]);
  assert.deepEqual(derivePaletteFamilies({ name: "No named hint", hex: null, rgb: { r: 0, g: 31, b: 128 } }), ["navy"]);
});
test("duplicate trimmed style inputs preserve first occurrence", () => {
  assert.deepEqual(dedupeStyleInputs([" PC61 ", "pc61", "SS:5000", "ss:5000", "PC61"]), ["PC61", "SS:5000"]);
});
test("family aliases use token and phrase boundaries, not substrings", () => {
  assert.deepEqual(derivePaletteFamilies({ name: "Redwood", hex: null, rgb: null }), []);
  assert.deepEqual(derivePaletteFamilies({ name: "Blueberry", hex: null, rgb: null }), []);
  assert.deepEqual(derivePaletteFamilies({ name: "Light Blue Heather", hex: null, rgb: null }), ["blue", "light blue"]);
  assert.deepEqual(derivePaletteFamilies({ name: "Warm Gray", hex: null, rgb: null }), ["grey"]);
});