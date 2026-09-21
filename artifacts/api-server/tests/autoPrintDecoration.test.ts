import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDecorationLines,
  destinationMappingForClassification,
  decorationKindForCategory,
} from "../src/lib/purchasing/decorationClassifier.ts";
import {
  conditionalAutoPrintDestination,
  successfulPostPrintCandidates,
} from "../src/lib/printQueue/autoPrint/routing.ts";
import {
  normalizeAutoPrintConfig,
  validateAutoPrintRoutingRules,
} from "../src/lib/printQueue/autoPrint/configValidation.ts";

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

test("old configs remain in simple mapping mode", () => {
  const config = normalizeAutoPrintConfig({ categoryMappings: mappings });
  assert.equal(config.routingMode, "simple");
  assert.deepEqual(config.routingRules, []);
  assert.equal(config.categoryMappings.length, 3);
});

test("conditional routing is first-match, exact decoration, due, and whole-word OR keywords", () => {
  const classification = classifyDecorationLines(
    [{ categoryName: "Screen Printing", items: 2 }],
    { positiveQuantityOnly: true },
  );
  const base = {
    enabled: true,
    dueComparator: "at_most" as const,
    dueBusinessDays: 5,
    nicknameKeywords: ["Due", "Rush"],
    decoration: "print" as const,
  };
  const rules = [
    { ...base, id: "first", statusId: "one", statusName: "One" },
    { ...base, id: "second", statusId: "two", statusName: "Two" },
  ];
  assert.equal(
    conditionalAutoPrintDestination(rules, {
      classification,
      businessDaysOut: 5,
      nickname: "HARD DUE 5/12",
    })?.id,
    "first",
  );
  assert.equal(
    conditionalAutoPrintDestination(rules, {
      classification,
      businessDaysOut: 6,
      nickname: "Rush",
    }),
    null,
  );
  assert.equal(
    conditionalAutoPrintDestination(rules, {
      classification,
      businessDaysOut: 3,
      nickname: "overdue",
    }),
    null,
  );
});

test("conditional no-match does not fall through legacy mappings", () => {
  const config = normalizeAutoPrintConfig({
    routingMode: "conditional",
    categoryMappings: mappings,
    routingRules: [],
  });
  assert.equal(config.routingMode, "conditional");
  assert.equal(
    conditionalAutoPrintDestination(config.routingRules, {
      classification: classifyDecorationLines(
        [{ categoryName: "Screen Printing", items: 1 }],
        { positiveQuantityOnly: true },
      ),
      businessDaysOut: 1,
      nickname: null,
    }),
    null,
  );
});

test("malformed conditional rules are rejected during persisted config normalization", () => {
  const valid = {
    id: "valid",
    enabled: false,
    decoration: "mixed",
    dueComparator: null,
    dueBusinessDays: null,
    nicknameKeywords: null,
    statusId: "target",
    statusName: "Target",
  };
  const config = normalizeAutoPrintConfig({
    routingMode: "conditional",
    routingRules: [
      valid,
      { ...valid, id: "bad-days", dueComparator: "at_most", dueBusinessDays: -1 },
      { ...valid, id: "bad-deco", decoration: "vinyl" },
    ],
  });
  assert.deepEqual(config.routingRules, [valid]);
  assert.match(
    validateAutoPrintRoutingRules([
      valid,
      { ...valid, id: "bad", dueComparator: "at_most", dueBusinessDays: null },
    ]) ?? "",
    /paired due comparator/,
  );
  assert.equal(
    validateAutoPrintRoutingRules([valid, { ...valid }]),
    "Conditional rule ids must be unique",
  );
});

test("post-print routing boundary includes successful physical prints only", () => {
  assert.deepEqual(
    successfulPostPrintCandidates([
      { candidate: "sent", outcome: "printed" },
      { candidate: "printer-error", outcome: "failed" },
      { candidate: "simulation", outcome: "dry_run" },
    ]),
    ["sent"],
  );
});