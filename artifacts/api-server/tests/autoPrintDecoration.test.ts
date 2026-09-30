import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDecorationLines,
  DECORATION_CATEGORY_LABELS,
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
import { UpdateAutoPrintConfigBody } from "../../../lib/api-zod/src/generated/api.ts";

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

test("SAMPLES is an exact line category with a stable mapping label and saved alias", () => {
  assert.equal(DECORATION_CATEGORY_LABELS.includes("SAMPLES"), true);
  assert.equal(decorationKindForCategory(" sample "), "samples");
  const classification = classifyDecorationLines(
    [
      { categoryName: "  SAMPLES  ", items: 2 },
      { categoryName: "Shipping", items: 1 },
      { categoryName: "Sample", items: 3 }, // alias only applies to saved mappings
      { categoryName: "SAMPLES - setup", items: 1 },
    ],
    { positiveQuantityOnly: true },
  );
  assert.deepEqual([...classification.groups], ["samples"]);
  assert.equal(classification.kind, "samples");
  assert.equal(
    destinationMappingForClassification(classification, [
      { category: " sample ", statusId: "sample-status", statusName: "Sample" },
    ])?.statusId,
    "sample-status",
  );
});

test("SAMPLES positive quantity and mixed composition follow existing routing rules", () => {
  const sampleMapping = { category: "SAMPLES", statusId: "samples-status", statusName: "Samples" };
  const mixedMapping = { category: "Mixed Decoration", statusId: "mixed-status", statusName: "Mixed" };
  const rules = [
    { id: "samples", decoration: "samples" as const, enabled: true, dueComparator: null, dueBusinessDays: null, nicknameKeywords: null, statusId: "samples-status", statusName: "Samples" },
    { id: "mixed", decoration: "mixed" as const, enabled: true, dueComparator: null, dueBusinessDays: null, nicknameKeywords: null, statusId: "mixed-status", statusName: "Mixed" },
  ];
  const candidate = (lines: { categoryName: string; items: number }[]) => ({
    classification: classifyDecorationLines(lines, { positiveQuantityOnly: true }),
    businessDaysOut: null,
    nickname: null,
  });
  const onlyZero = candidate([{ categoryName: "SAMPLES", items: 0 }]);
  assert.equal(onlyZero.classification.kind, null);
  assert.equal(destinationMappingForClassification(onlyZero.classification, [sampleMapping]), null);
  assert.equal(conditionalAutoPrintDestination(rules, onlyZero), null);

  const sampleOnly = candidate([
    { categoryName: "SAMPLES", items: 4 },
    { categoryName: "Embroidery", items: 0 },
  ]);
  assert.equal(sampleOnly.classification.kind, "samples");
  assert.equal(destinationMappingForClassification(sampleOnly.classification, [sampleMapping])?.statusId, "samples-status");
  assert.equal(conditionalAutoPrintDestination(rules, sampleOnly)?.id, "samples");

  const mixed = candidate([
    { categoryName: "SAMPLES", items: 4 },
    { categoryName: "Embroidery", items: 1 },
  ]);
  assert.equal(mixed.classification.kind, "mixed");
  assert.equal(destinationMappingForClassification(mixed.classification, [sampleMapping, mixedMapping])?.statusId, "mixed-status");
  assert.equal(destinationMappingForClassification(mixed.classification, [sampleMapping]), null);
  assert.equal(conditionalAutoPrintDestination(rules, mixed)?.id, "mixed");
});

test("API schema accepts SAMPLES conditional rules and config normalization retains them on reload", () => {
  const rule = {
    id: "sample-only", enabled: true, decoration: "samples", dueComparator: null,
    dueBusinessDays: null, nicknameKeywords: null, statusId: "sample-status", statusName: "Sample",
  };
  const payload = {
    ...normalizeAutoPrintConfig(null),
    categoryMappings: [{ category: "SAMPLES", statusId: "sample-status", statusName: "Sample" }],
    routingMode: "conditional",
    routingRules: [rule],
  };
  const parsed = UpdateAutoPrintConfigBody.safeParse(payload);
  assert.equal(parsed.success, true);
  assert.equal(validateAutoPrintRoutingRules(payload.routingRules), null);
  const reloaded = normalizeAutoPrintConfig(JSON.parse(JSON.stringify(parsed.data)));
  assert.deepEqual(reloaded.categoryMappings, payload.categoryMappings);
  assert.deepEqual(reloaded.routingRules, [rule]);
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
  assert.equal(classifyDecorationLines([{ categoryName: "SAMPLES", items: 0 }]).kind, "samples");
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