import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDecorationLines,
  destinationMappingForClassification,
  decorationKindForCategory,
} from "../src/lib/purchasing/decorationClassifier.ts";

const mappings = [
  { category: "Screen Printing", statusId: "screen-status", statusName: "Screen" },
  { category: "Embroidery", statusId: "emb-status", statusName: "Embroidery" },
  { category: "Mixed Decoration", statusId: "mixed-status", statusName: "Mixed" },
];

test("order 18371 uses its positive line-item Screen Printing category with null imprints", () => {
  const classification = classifyDecorationLines(
    [{ categoryName: "Screen Printing", items: 12 }],
    { positiveQuantityOnly: true },
  );

  assert.equal(classification.kind, "print");
  assert.equal(
    destinationMappingForClassification(classification, mappings)?.statusId,
    "screen-status",
  );
});

test("mixed line-item composition takes precedence over a single method", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Screen Printing", items: 1 },
      { categoryName: "Embroidery", items: 1 },
    ],
    { positiveQuantityOnly: true },
  );

  assert.equal(classification.kind, "mixed");
  assert.equal(
    destinationMappingForClassification(classification, mappings)?.statusId,
    "mixed-status",
  );
  assert.equal(
    destinationMappingForClassification(classification, mappings.slice(0, 2)),
    null,
  );
});

test("explicit Mixed Decoration is mixed even beside one single method", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Screen Printing", items: 1 },
      { categoryName: "Mixed Decoration", items: 1 },
    ],
    { positiveQuantityOnly: true },
  );

  assert.equal(classification.kind, "mixed");
  assert.equal(
    destinationMappingForClassification(classification, mappings)?.statusId,
    "mixed-status",
  );
});

test("ignored categories do not add a decoration group", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Shipping", items: 1 },
      { categoryName: "Extras", items: 3 },
      { categoryName: "Screen Printing", items: 2 },
    ],
    { positiveQuantityOnly: true },
  );

  assert.deepEqual([...classification.groups], ["print"]);
  assert.equal(classification.kind, "print");
});

test("known category aliases normalize for lines and saved mappings", () => {
  assert.equal(decorationKindForCategory("screen print"), "print");
  assert.equal(decorationKindForCategory("Heat Press"), "heat");
  assert.equal(decorationKindForCategory("Embroidery - Setup/Digitizing"), "embroidery");
  const classification = classifyDecorationLines(
    [{ categoryName: "Screen Printing", items: 1 }],
    { positiveQuantityOnly: true },
  );
  assert.equal(
    destinationMappingForClassification(classification, [
      { category: "screen print", statusId: "status", statusName: "Status" },
    ])?.statusId,
    "status",
  );
});

test("zero, negative, and missing quantities do not classify for auto-print", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Screen Printing", items: 0 },
      { categoryName: "Embroidery", items: -1 },
      { categoryName: "Heat Applied Graphics", items: null },
    ],
    { positiveQuantityOnly: true },
  );

  assert.equal(classification.kind, null);
  assert.equal(
    destinationMappingForClassification(classification, mappings),
    null,
  );
});

test("default shared classification retains Purchasing zero-quantity semantics", () => {
  const classification = classifyDecorationLines([
    { categoryName: "Screen Printing", items: 0 },
  ]);

  assert.equal(classification.kind, "print");
});

test("unknown saved mappings stay unmatched instead of silently routing", () => {
  const classification = classifyDecorationLines(
    [{ categoryName: "Screen Printing", items: 1 }],
    { positiveQuantityOnly: true },
  );

  assert.equal(
    destinationMappingForClassification(classification, [
      { category: "Future Decoration", statusId: "future", statusName: "Future" },
    ]),
    null,
  );
});