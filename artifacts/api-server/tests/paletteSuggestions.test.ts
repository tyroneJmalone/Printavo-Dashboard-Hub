import test from "node:test";
import assert from "node:assert/strict";
import { dedupeStyleInputs, derivePaletteFamilies, rankPaletteColor } from "../src/lib/catalog/paletteSuggestions";

const garment = (colorName: string, families: string[] = []) => ({
  colorName, normName: colorName.toLowerCase(), families, swatchImage: null, productImage: null,
});
const palette = (name: string, role = "primary") => [{ id: "color-1", role, name, hex: null }];

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
  assert.deepEqual(derivePaletteFamilies({ name: "Brand color", hex: "#001f80" }), ["navy"]);
});
test("palette RGB is hex-only: name hints still work, no hex means no hue-derived family", () => {
  // The branding catalog stores no separate RGB value anymore — RGB is always
  // derived from hex, so RGB-object inputs are intentionally unsupported.
  assert.deepEqual(derivePaletteFamilies({ name: "Warm Gray", hex: null }), ["grey"]);
  assert.deepEqual(derivePaletteFamilies({ name: "No named hint", hex: null }), []);
  assert.deepEqual(derivePaletteFamilies({ name: "No named hint", hex: "#001f80" }), ["navy"]);
});
test("duplicate trimmed style inputs preserve first occurrence", () => {
  assert.deepEqual(dedupeStyleInputs([" PC61 ", "pc61", "SS:5000", "ss:5000", "PC61"]), ["PC61", "SS:5000"]);
});
test("family aliases use token and phrase boundaries, not substrings", () => {
  assert.deepEqual(derivePaletteFamilies({ name: "Redwood", hex: null }), []);
  assert.deepEqual(derivePaletteFamilies({ name: "Blueberry", hex: null }), []);
  assert.deepEqual(derivePaletteFamilies({ name: "Light Blue Heather", hex: null }), ["blue", "light blue"]);
  assert.deepEqual(derivePaletteFamilies({ name: "Warm Gray", hex: null }), ["grey"]);
});
test("measured visual match exposes web-swatch provenance", () => {
  const hit = rankPaletteColor(
    { ...garment("Ocean"), evidence: { status: "measured", lab: [53.24, 80.09, 67.2], rgb: [255, 0, 0], sourceSwatchUrl: "https://cdnm.sanmar.com/red.png", sourceSwatchHash: "hash", reason: "web swatch", profile: "sRGB", illuminant: "D65", measuredAt: "2026-01-01T00:00:00.000Z", confidence: "medium", quality: "uniform", method: "central", algorithmVersion: "v1" } },
    [{ id: "red", role: "primary", name: "Brand red", hex: "#ff0000", pantoneCode: "TEST-PMS-RED" }],
  );
  assert.equal(hit.matchMethod, "visual_delta_e");
  assert.equal(hit.matchedCustomer.pantoneCode, "TEST-PMS-RED");
  assert.equal(hit.evidence?.sourceSwatchHash, "hash");
  assert.equal(hit.evidence?.illuminant, "D65");
});