import test from "node:test";
import assert from "node:assert/strict";
import {
  findReusableColorMatch,
  findUniqueOneSizeOffer,
  sanmarPoNumberTooLong,
  suggestedPoNumber,
} from "./cartMatching.ts";

test("normalizes SanMar JetBlack but exposes it as an approximate match", () => {
  assert.deepEqual(findReusableColorMatch("Jet Black", ["Navy", "JetBlack"]), {
    kind: "normalized",
    value: "JetBlack",
  });
});

test("leaves normalized color collisions for manual selection", () => {
  assert.deepEqual(findReusableColorMatch("Jet Black", ["JetBlack", "Jet-Black"]), {
    kind: "ambiguous",
    value: null,
  });
});

test("accepts unique common abbreviations and clear minor typos", () => {
  assert.deepEqual(findReusableColorMatch("Dk Navy Hthr", ["Dark Navy Heather", "Red"]), {
    kind: "normalized",
    value: "Dark Navy Heather",
  });
  assert.deepEqual(findReusableColorMatch("Charcol", ["Charcoal", "Navy"]), {
    kind: "normalized",
    value: "Charcoal",
  });
});

test("protects meaningful modifiers instead of choosing a wrong nearby color", () => {
  assert.deepEqual(findReusableColorMatch("Black", ["Black Heather", "Navy"]), {
    kind: "ambiguous",
    value: null,
  });
  assert.deepEqual(findReusableColorMatch("Solid Black", ["Black", "Black Heather"]), {
    kind: "ambiguous",
    value: null,
  });
  assert.deepEqual(findReusableColorMatch("Light Red", ["Dark Red", "Navy"]), {
    kind: "ambiguous",
    value: null,
  });
});

test("keeps similarly named red and navy choices manual without a clear margin", () => {
  assert.deepEqual(findReusableColorMatch("True Re", ["True Red", "True Rev"]), {
    kind: "ambiguous",
    value: null,
  });
  assert.deepEqual(findReusableColorMatch("Navy", ["Red", "Royal"]), {
    kind: "none",
    value: null,
  });
});

test("maps Printavo Quantity aliases only to one unambiguous one-size offer", () => {
  const osfm = { size: "ONE SIZE FITS MOST", sku: "SKU-OSFM" };
  assert.equal(findUniqueOneSizeOffer("Quantity", [osfm, { size: "S", sku: "SKU-S" }]), osfm);
  assert.equal(findUniqueOneSizeOffer("Quantitiy", [{ size: "OS", sku: "SKU-OS" }])?.sku, "SKU-OS");
  assert.equal(
    findUniqueOneSizeOffer("OTHER", [{ size: "ONE SIZE", sku: "B84095500" }])?.sku,
    "B84095500",
  );
  assert.equal(
    findUniqueOneSizeOffer("Quantity", [osfm, { size: "OS", sku: "SKU-OS" }]),
    null,
  );
  assert.equal(
    findUniqueOneSizeOffer("OTHER", [
      { size: "ONE SIZE", sku: "SKU-ONE" },
      { size: "OS", sku: "SKU-OS" },
    ]),
    null,
  );
});

test("does not treat blank/default Printavo size labels as generic quantity", () => {
  const offer = { size: "OS", sku: "SKU-OS" };
  assert.equal(findUniqueOneSizeOffer("", [offer]), null);
  assert.equal(findUniqueOneSizeOffer("defaultBlank", [offer]), null);
});

test("generates contiguous deterministic invoice suffixes and preserves zeroes", () => {
  assert.equal(
    suggestedPoNumber([
      { printavoOrderId: "b", visualId: 12007 },
      { printavoOrderId: "a", visualId: 42 },
      { printavoOrderId: "b", visualId: 12007 },
      { printavoOrderId: "c", visualId: 1010 },
    ]),
    "042010007",
  );
});

test("SanMar PO number validation accepts 12 characters and rejects more", () => {
  assert.equal(sanmarPoNumberTooLong("001002003004"), false);
  assert.equal(sanmarPoNumberTooLong("001002003004005"), true);
  assert.equal(sanmarPoNumberTooLong(" MANUAL123456 "), false);
});