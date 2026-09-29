// tests/autoPrintDecoration.test.ts
import assert from "node:assert/strict";
import test from "node:test";

// src/lib/purchasing/decorationClassifier.ts
var LINE_CATEGORY_TO_GROUP = {
  "screen printing": "print",
  "heat applied graphics": "heat",
  "heat applied graphics - personalizations": "heat",
  embroidery: "embroidery",
  "embroidery - personalizations": "embroidery",
  "embroidery - set up/digitizing": "embroidery"
};
var CATEGORY_ALIASES = {
  "screen print": "print",
  screenprinting: "print",
  "screen prints": "print",
  silkscreen: "print",
  "silk screen": "print",
  sp: "print",
  "heat applied graphic": "heat",
  "heat applied graphics - personalization": "heat",
  "heat applied": "heat",
  "heat press": "heat",
  dtf: "heat",
  "embroidery - personalization": "embroidery",
  "embroidery - setup/digitizing": "embroidery",
  "embroidery - set up": "embroidery",
  "embroidery - digitizing": "embroidery",
  emb: "embroidery"
};
var MIXED_CATEGORY_ALIASES = /* @__PURE__ */ new Set([
  "mixed decoration",
  "mixed decorations"
]);
function normalizeDecorationCategory(name) {
  return (name ?? "").trim().toLowerCase().replace(/[‐‑‒–—―]/g, "-").replace(/\s+/g, " ");
}
function decorationKindForCategory(category) {
  const normalized = normalizeDecorationCategory(category);
  if (MIXED_CATEGORY_ALIASES.has(normalized)) return "mixed";
  return LINE_CATEGORY_TO_GROUP[normalized] ?? CATEGORY_ALIASES[normalized] ?? null;
}
function lineDecorationKind(category) {
  const normalized = (category ?? "").trim().toLowerCase();
  if (normalized === "mixed decoration") return "mixed";
  return LINE_CATEGORY_TO_GROUP[normalized] ?? null;
}
function classifyDecorationLines(lines, options = {}) {
  const groups = /* @__PURE__ */ new Set();
  let explicitMixed = false;
  for (const line of lines) {
    if (options.positiveQuantityOnly && !(line.items != null && line.items > 0)) {
      continue;
    }
    const kind2 = lineDecorationKind(line.categoryName);
    if (kind2 === "mixed") {
      explicitMixed = true;
    } else if (kind2) {
      groups.add(kind2);
    }
  }
  const mixed = explicitMixed || groups.size > 1;
  const kind = mixed ? "mixed" : groups.size === 1 ? [...groups][0] : null;
  return { groups, mixed, kind };
}
function destinationMappingForClassification(classification, mappings2) {
  if (!classification.kind) return null;
  for (const mapping of mappings2) {
    if (decorationKindForCategory(mapping.category) === classification.kind) {
      return mapping;
    }
  }
  return null;
}

// src/lib/purchasing/ruleMatching.ts
var escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function nicknameHasKeyword(nickname, keywords) {
  if (!nickname) return false;
  return keywords.some(
    (kw) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(kw)}([^\\p{L}\\p{N}]|$)`, "iu").test(nickname)
  );
}
function ruleKeywords(raw) {
  if (!Array.isArray(raw)) return null;
  const words = raw.filter((word) => typeof word === "string" && word.trim() !== "");
  return words.length ? words : null;
}
function ruleMatches(rule, comp, businessDaysOut, nickname = null) {
  if (rule.specialMixedDeco) {
    if (!comp.mixed) return false;
  } else if (rule.decoGroup) {
    if (comp.mixed) return false;
    if (comp.groups.size !== 1 || !comp.groups.has(rule.decoGroup)) return false;
  }
  if (rule.dueComparator && rule.dueBusinessDays != null) {
    if (businessDaysOut == null) return false;
    if (rule.dueComparator === "more_than" && businessDaysOut <= rule.dueBusinessDays) return false;
    if (rule.dueComparator === "at_most" && businessDaysOut > rule.dueBusinessDays) return false;
  }
  const keywords = ruleKeywords(rule.nicknameKeywords);
  return !keywords || nicknameHasKeyword(nickname, keywords);
}

// src/lib/printQueue/autoPrint/routing.ts
function successfulPostPrintCandidates(outcomes) {
  return outcomes.filter((item) => item.outcome === "printed").map((item) => item.candidate);
}
function conditionalAutoPrintDestination(rules, candidate) {
  const comp = {
    groups: candidate.classification.groups,
    mixed: candidate.classification.mixed
  };
  return rules.find((rule) => {
    if (!rule.enabled) return false;
    return ruleMatches(
      {
        specialMixedDeco: rule.decoration === "mixed",
        decoGroup: rule.decoration === "any" || rule.decoration === "mixed" ? null : rule.decoration,
        dueComparator: rule.dueComparator,
        dueBusinessDays: rule.dueBusinessDays,
        nicknameKeywords: rule.nicknameKeywords
      },
      comp,
      candidate.businessDaysOut,
      candidate.nickname
    );
  }) ?? null;
}

// src/lib/printQueue/autoPrint/configValidation.ts
var DEFAULT_DAILY_TIMES = ["06:00"];
var MAX_DAILY_TIMES = 12;
var DAILY_TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
var DEFAULT_AUTO_PRINT_CONFIG = {
  enabled: false,
  scheduleMode: "interval",
  scheduleHours: 6,
  dailyTimes: [...DEFAULT_DAILY_TIMES],
  sourceStatusIds: [],
  errorStatusId: null,
  errorStatusName: null,
  printerId: null,
  printerName: null,
  copies: 1,
  dryRun: true,
  excludeAttachments: false,
  categoryMappings: [],
  routingMode: "simple",
  routingRules: []
};
var DECORATIONS = /* @__PURE__ */ new Set(["any", "print", "heat", "embroidery", "mixed"]);
var COMPARATORS = /* @__PURE__ */ new Set(["more_than", "at_most"]);
function isValidAutoPrintRoutingRule(value) {
  if (!value || typeof value !== "object") return false;
  const r = value;
  if (typeof r.id !== "string" || !r.id || typeof r.enabled !== "boolean" || !DECORATIONS.has(String(r.decoration)) || typeof r.statusId !== "string" || !r.statusId || typeof r.statusName !== "string") return false;
  if (r.dueComparator == null !== (r.dueBusinessDays == null)) return false;
  if (r.dueComparator != null && (!COMPARATORS.has(r.dueComparator) || !Number.isInteger(r.dueBusinessDays) || r.dueBusinessDays < 0)) return false;
  return r.nicknameKeywords == null || Array.isArray(r.nicknameKeywords) && r.nicknameKeywords.length <= 20 && r.nicknameKeywords.every(
    (word) => typeof word === "string" && word.trim().length > 0 && word.length <= 60
  );
}
function validateAutoPrintRoutingRules(value) {
  if (!Array.isArray(value)) return "Conditional rules must be a list";
  if (value.some((rule) => !isValidAutoPrintRoutingRule(rule))) {
    return "Each conditional rule needs a valid decoration, paired due comparator and non-negative business-day count, up to 20 nickname keywords, and a target status";
  }
  const ids = value.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) return "Conditional rule ids must be unique";
  return null;
}
function isAutoPrintScheduleMode(value) {
  return value === "interval" || value === "daily";
}
function isDailyTime(value) {
  return typeof value === "string" && DAILY_TIME_PATTERN.test(value);
}
function normalizeDailyTimes(value) {
  if (!Array.isArray(value)) return [...DEFAULT_DAILY_TIMES];
  const times = [
    ...new Set(value.filter((item) => isDailyTime(item)))
  ].sort();
  return times.length > 0 ? times.slice(0, MAX_DAILY_TIMES) : [...DEFAULT_DAILY_TIMES];
}
function normalizeAutoPrintConfig(raw) {
  const v = raw ?? {};
  const d = DEFAULT_AUTO_PRINT_CONFIG;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    scheduleMode: isAutoPrintScheduleMode(v.scheduleMode) ? v.scheduleMode : d.scheduleMode,
    scheduleHours: typeof v.scheduleHours === "number" && Number.isInteger(v.scheduleHours) && v.scheduleHours >= 1 && v.scheduleHours <= 24 ? v.scheduleHours : d.scheduleHours,
    dailyTimes: normalizeDailyTimes(v.dailyTimes),
    sourceStatusIds: Array.isArray(v.sourceStatusIds) ? v.sourceStatusIds.filter((s) => typeof s === "string") : d.sourceStatusIds,
    errorStatusId: typeof v.errorStatusId === "string" ? v.errorStatusId : null,
    errorStatusName: typeof v.errorStatusName === "string" ? v.errorStatusName : null,
    printerId: typeof v.printerId === "string" ? v.printerId : null,
    printerName: typeof v.printerName === "string" ? v.printerName : null,
    copies: typeof v.copies === "number" && Number.isInteger(v.copies) && v.copies >= 1 && v.copies <= 10 ? v.copies : d.copies,
    dryRun: typeof v.dryRun === "boolean" ? v.dryRun : d.dryRun,
    excludeAttachments: typeof v.excludeAttachments === "boolean" ? v.excludeAttachments : d.excludeAttachments,
    categoryMappings: Array.isArray(v.categoryMappings) ? v.categoryMappings.filter(
      (m) => !!m && typeof m.category === "string" && m.category.length > 0 && typeof m.statusId === "string" && typeof m.statusName === "string"
    ) : d.categoryMappings,
    routingMode: v.routingMode === "conditional" ? "conditional" : "simple",
    routingRules: Array.isArray(v.routingRules) ? v.routingRules.filter(isValidAutoPrintRoutingRule).map((rule) => ({
      ...rule,
      nicknameKeywords: rule.nicknameKeywords ? [...new Map(rule.nicknameKeywords.map((word) => [word.trim().toLowerCase(), word.trim()])).values()] : null
    })) : []
  };
}

// tests/autoPrintDecoration.test.ts
var mappings = [
  { category: "Screen Printing", statusId: "screen-status", statusName: "Screen" },
  { category: "Embroidery", statusId: "emb-status", statusName: "Embroidery" },
  { category: "Mixed Decoration", statusId: "mixed-status", statusName: "Mixed" }
];
test("order 18371 uses its positive line-item Screen Printing category with null imprints", () => {
  const classification = classifyDecorationLines(
    [{ categoryName: "Screen Printing", items: 12 }],
    { positiveQuantityOnly: true }
  );
  assert.equal(classification.kind, "print");
  assert.equal(
    destinationMappingForClassification(classification, mappings)?.statusId,
    "screen-status"
  );
});
test("mixed line-item composition takes precedence over a single method", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Screen Printing", items: 1 },
      { categoryName: "Embroidery", items: 1 }
    ],
    { positiveQuantityOnly: true }
  );
  assert.equal(classification.kind, "mixed");
  assert.equal(
    destinationMappingForClassification(classification, mappings)?.statusId,
    "mixed-status"
  );
  assert.equal(
    destinationMappingForClassification(classification, mappings.slice(0, 2)),
    null
  );
});
test("explicit Mixed Decoration is mixed even beside one single method", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Screen Printing", items: 1 },
      { categoryName: "Mixed Decoration", items: 1 }
    ],
    { positiveQuantityOnly: true }
  );
  assert.equal(classification.kind, "mixed");
  assert.equal(
    destinationMappingForClassification(classification, mappings)?.statusId,
    "mixed-status"
  );
});
test("ignored categories do not add a decoration group", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Shipping", items: 1 },
      { categoryName: "Extras", items: 3 },
      { categoryName: "Screen Printing", items: 2 }
    ],
    { positiveQuantityOnly: true }
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
    { positiveQuantityOnly: true }
  );
  assert.equal(
    destinationMappingForClassification(classification, [
      { category: "screen print", statusId: "status", statusName: "Status" }
    ])?.statusId,
    "status"
  );
});
test("zero, negative, and missing quantities do not classify for auto-print", () => {
  const classification = classifyDecorationLines(
    [
      { categoryName: "Screen Printing", items: 0 },
      { categoryName: "Embroidery", items: -1 },
      { categoryName: "Heat Applied Graphics", items: null }
    ],
    { positiveQuantityOnly: true }
  );
  assert.equal(classification.kind, null);
  assert.equal(
    destinationMappingForClassification(classification, mappings),
    null
  );
});
test("default shared classification retains Purchasing zero-quantity semantics", () => {
  const classification = classifyDecorationLines([
    { categoryName: "Screen Printing", items: 0 }
  ]);
  assert.equal(classification.kind, "print");
});
test("unknown saved mappings stay unmatched instead of silently routing", () => {
  const classification = classifyDecorationLines(
    [{ categoryName: "Screen Printing", items: 1 }],
    { positiveQuantityOnly: true }
  );
  assert.equal(
    destinationMappingForClassification(classification, [
      { category: "Future Decoration", statusId: "future", statusName: "Future" }
    ]),
    null
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
    { positiveQuantityOnly: true }
  );
  const base = {
    enabled: true,
    dueComparator: "at_most",
    dueBusinessDays: 5,
    nicknameKeywords: ["Due", "Rush"],
    decoration: "print"
  };
  const rules = [
    { ...base, id: "first", statusId: "one", statusName: "One" },
    { ...base, id: "second", statusId: "two", statusName: "Two" }
  ];
  assert.equal(
    conditionalAutoPrintDestination(rules, {
      classification,
      businessDaysOut: 5,
      nickname: "HARD DUE 5/12"
    })?.id,
    "first"
  );
  assert.equal(
    conditionalAutoPrintDestination(rules, {
      classification,
      businessDaysOut: 6,
      nickname: "Rush"
    }),
    null
  );
  assert.equal(
    conditionalAutoPrintDestination(rules, {
      classification,
      businessDaysOut: 3,
      nickname: "overdue"
    }),
    null
  );
});
test("conditional no-match does not fall through legacy mappings", () => {
  const config = normalizeAutoPrintConfig({
    routingMode: "conditional",
    categoryMappings: mappings,
    routingRules: []
  });
  assert.equal(config.routingMode, "conditional");
  assert.equal(
    conditionalAutoPrintDestination(config.routingRules, {
      classification: classifyDecorationLines(
        [{ categoryName: "Screen Printing", items: 1 }],
        { positiveQuantityOnly: true }
      ),
      businessDaysOut: 1,
      nickname: null
    }),
    null
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
    statusName: "Target"
  };
  const config = normalizeAutoPrintConfig({
    routingMode: "conditional",
    routingRules: [
      valid,
      { ...valid, id: "bad-days", dueComparator: "at_most", dueBusinessDays: -1 },
      { ...valid, id: "bad-deco", decoration: "vinyl" }
    ]
  });
  assert.deepEqual(config.routingRules, [valid]);
  assert.match(
    validateAutoPrintRoutingRules([
      valid,
      { ...valid, id: "bad", dueComparator: "at_most", dueBusinessDays: null }
    ]) ?? "",
    /paired due comparator/
  );
  assert.equal(
    validateAutoPrintRoutingRules([valid, { ...valid }]),
    "Conditional rule ids must be unique"
  );
});
test("post-print routing boundary includes successful physical prints only", () => {
  assert.deepEqual(
    successfulPostPrintCandidates([
      { candidate: "sent", outcome: "printed" },
      { candidate: "printer-error", outcome: "failed" },
      { candidate: "simulation", outcome: "dry_run" }
    ]),
    ["sent"]
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidGVzdHMvYXV0b1ByaW50RGVjb3JhdGlvbi50ZXN0LnRzIiwgInNyYy9saWIvcHVyY2hhc2luZy9kZWNvcmF0aW9uQ2xhc3NpZmllci50cyIsICJzcmMvbGliL3B1cmNoYXNpbmcvcnVsZU1hdGNoaW5nLnRzIiwgInNyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvcm91dGluZy50cyIsICJzcmMvbGliL3ByaW50UXVldWUvYXV0b1ByaW50L2NvbmZpZ1ZhbGlkYXRpb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHtcbiAgY2xhc3NpZnlEZWNvcmF0aW9uTGluZXMsXG4gIGRlc3RpbmF0aW9uTWFwcGluZ0ZvckNsYXNzaWZpY2F0aW9uLFxuICBkZWNvcmF0aW9uS2luZEZvckNhdGVnb3J5LFxufSBmcm9tIFwiLi4vc3JjL2xpYi9wdXJjaGFzaW5nL2RlY29yYXRpb25DbGFzc2lmaWVyLnRzXCI7XG5pbXBvcnQge1xuICBjb25kaXRpb25hbEF1dG9QcmludERlc3RpbmF0aW9uLFxuICBzdWNjZXNzZnVsUG9zdFByaW50Q2FuZGlkYXRlcyxcbn0gZnJvbSBcIi4uL3NyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvcm91dGluZy50c1wiO1xuaW1wb3J0IHtcbiAgbm9ybWFsaXplQXV0b1ByaW50Q29uZmlnLFxuICB2YWxpZGF0ZUF1dG9QcmludFJvdXRpbmdSdWxlcyxcbn0gZnJvbSBcIi4uL3NyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvY29uZmlnVmFsaWRhdGlvbi50c1wiO1xuXG5jb25zdCBtYXBwaW5ncyA9IFtcbiAgeyBjYXRlZ29yeTogXCJTY3JlZW4gUHJpbnRpbmdcIiwgc3RhdHVzSWQ6IFwic2NyZWVuLXN0YXR1c1wiLCBzdGF0dXNOYW1lOiBcIlNjcmVlblwiIH0sXG4gIHsgY2F0ZWdvcnk6IFwiRW1icm9pZGVyeVwiLCBzdGF0dXNJZDogXCJlbWItc3RhdHVzXCIsIHN0YXR1c05hbWU6IFwiRW1icm9pZGVyeVwiIH0sXG4gIHsgY2F0ZWdvcnk6IFwiTWl4ZWQgRGVjb3JhdGlvblwiLCBzdGF0dXNJZDogXCJtaXhlZC1zdGF0dXNcIiwgc3RhdHVzTmFtZTogXCJNaXhlZFwiIH0sXG5dO1xuXG50ZXN0KFwib3JkZXIgMTgzNzEgdXNlcyBpdHMgcG9zaXRpdmUgbGluZS1pdGVtIFNjcmVlbiBQcmludGluZyBjYXRlZ29yeSB3aXRoIG51bGwgaW1wcmludHNcIiwgKCkgPT4ge1xuICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5RGVjb3JhdGlvbkxpbmVzKFxuICAgIFt7IGNhdGVnb3J5TmFtZTogXCJTY3JlZW4gUHJpbnRpbmdcIiwgaXRlbXM6IDEyIH1dLFxuICAgIHsgcG9zaXRpdmVRdWFudGl0eU9ubHk6IHRydWUgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoY2xhc3NpZmljYXRpb24ua2luZCwgXCJwcmludFwiKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGRlc3RpbmF0aW9uTWFwcGluZ0ZvckNsYXNzaWZpY2F0aW9uKGNsYXNzaWZpY2F0aW9uLCBtYXBwaW5ncyk/LnN0YXR1c0lkLFxuICAgIFwic2NyZWVuLXN0YXR1c1wiLFxuICApO1xufSk7XG5cbnRlc3QoXCJtaXhlZCBsaW5lLWl0ZW0gY29tcG9zaXRpb24gdGFrZXMgcHJlY2VkZW5jZSBvdmVyIGEgc2luZ2xlIG1ldGhvZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlEZWNvcmF0aW9uTGluZXMoXG4gICAgW1xuICAgICAgeyBjYXRlZ29yeU5hbWU6IFwiU2NyZWVuIFByaW50aW5nXCIsIGl0ZW1zOiAxIH0sXG4gICAgICB7IGNhdGVnb3J5TmFtZTogXCJFbWJyb2lkZXJ5XCIsIGl0ZW1zOiAxIH0sXG4gICAgXSxcbiAgICB7IHBvc2l0aXZlUXVhbnRpdHlPbmx5OiB0cnVlIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZpY2F0aW9uLmtpbmQsIFwibWl4ZWRcIik7XG4gIGFzc2VydC5lcXVhbChcbiAgICBkZXN0aW5hdGlvbk1hcHBpbmdGb3JDbGFzc2lmaWNhdGlvbihjbGFzc2lmaWNhdGlvbiwgbWFwcGluZ3MpPy5zdGF0dXNJZCxcbiAgICBcIm1peGVkLXN0YXR1c1wiLFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZGVzdGluYXRpb25NYXBwaW5nRm9yQ2xhc3NpZmljYXRpb24oY2xhc3NpZmljYXRpb24sIG1hcHBpbmdzLnNsaWNlKDAsIDIpKSxcbiAgICBudWxsLFxuICApO1xufSk7XG5cbnRlc3QoXCJleHBsaWNpdCBNaXhlZCBEZWNvcmF0aW9uIGlzIG1peGVkIGV2ZW4gYmVzaWRlIG9uZSBzaW5nbGUgbWV0aG9kXCIsICgpID0+IHtcbiAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeURlY29yYXRpb25MaW5lcyhcbiAgICBbXG4gICAgICB7IGNhdGVnb3J5TmFtZTogXCJTY3JlZW4gUHJpbnRpbmdcIiwgaXRlbXM6IDEgfSxcbiAgICAgIHsgY2F0ZWdvcnlOYW1lOiBcIk1peGVkIERlY29yYXRpb25cIiwgaXRlbXM6IDEgfSxcbiAgICBdLFxuICAgIHsgcG9zaXRpdmVRdWFudGl0eU9ubHk6IHRydWUgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoY2xhc3NpZmljYXRpb24ua2luZCwgXCJtaXhlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGRlc3RpbmF0aW9uTWFwcGluZ0ZvckNsYXNzaWZpY2F0aW9uKGNsYXNzaWZpY2F0aW9uLCBtYXBwaW5ncyk/LnN0YXR1c0lkLFxuICAgIFwibWl4ZWQtc3RhdHVzXCIsXG4gICk7XG59KTtcblxudGVzdChcImlnbm9yZWQgY2F0ZWdvcmllcyBkbyBub3QgYWRkIGEgZGVjb3JhdGlvbiBncm91cFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlEZWNvcmF0aW9uTGluZXMoXG4gICAgW1xuICAgICAgeyBjYXRlZ29yeU5hbWU6IFwiU2hpcHBpbmdcIiwgaXRlbXM6IDEgfSxcbiAgICAgIHsgY2F0ZWdvcnlOYW1lOiBcIkV4dHJhc1wiLCBpdGVtczogMyB9LFxuICAgICAgeyBjYXRlZ29yeU5hbWU6IFwiU2NyZWVuIFByaW50aW5nXCIsIGl0ZW1zOiAyIH0sXG4gICAgXSxcbiAgICB7IHBvc2l0aXZlUXVhbnRpdHlPbmx5OiB0cnVlIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChbLi4uY2xhc3NpZmljYXRpb24uZ3JvdXBzXSwgW1wicHJpbnRcIl0pO1xuICBhc3NlcnQuZXF1YWwoY2xhc3NpZmljYXRpb24ua2luZCwgXCJwcmludFwiKTtcbn0pO1xuXG50ZXN0KFwia25vd24gY2F0ZWdvcnkgYWxpYXNlcyBub3JtYWxpemUgZm9yIGxpbmVzIGFuZCBzYXZlZCBtYXBwaW5nc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChkZWNvcmF0aW9uS2luZEZvckNhdGVnb3J5KFwic2NyZWVuIHByaW50XCIpLCBcInByaW50XCIpO1xuICBhc3NlcnQuZXF1YWwoZGVjb3JhdGlvbktpbmRGb3JDYXRlZ29yeShcIkhlYXQgUHJlc3NcIiksIFwiaGVhdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY29yYXRpb25LaW5kRm9yQ2F0ZWdvcnkoXCJFbWJyb2lkZXJ5IC0gU2V0dXAvRGlnaXRpemluZ1wiKSwgXCJlbWJyb2lkZXJ5XCIpO1xuICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5RGVjb3JhdGlvbkxpbmVzKFxuICAgIFt7IGNhdGVnb3J5TmFtZTogXCJTY3JlZW4gUHJpbnRpbmdcIiwgaXRlbXM6IDEgfV0sXG4gICAgeyBwb3NpdGl2ZVF1YW50aXR5T25seTogdHJ1ZSB9LFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZGVzdGluYXRpb25NYXBwaW5nRm9yQ2xhc3NpZmljYXRpb24oY2xhc3NpZmljYXRpb24sIFtcbiAgICAgIHsgY2F0ZWdvcnk6IFwic2NyZWVuIHByaW50XCIsIHN0YXR1c0lkOiBcInN0YXR1c1wiLCBzdGF0dXNOYW1lOiBcIlN0YXR1c1wiIH0sXG4gICAgXSk/LnN0YXR1c0lkLFxuICAgIFwic3RhdHVzXCIsXG4gICk7XG59KTtcblxudGVzdChcInplcm8sIG5lZ2F0aXZlLCBhbmQgbWlzc2luZyBxdWFudGl0aWVzIGRvIG5vdCBjbGFzc2lmeSBmb3IgYXV0by1wcmludFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlEZWNvcmF0aW9uTGluZXMoXG4gICAgW1xuICAgICAgeyBjYXRlZ29yeU5hbWU6IFwiU2NyZWVuIFByaW50aW5nXCIsIGl0ZW1zOiAwIH0sXG4gICAgICB7IGNhdGVnb3J5TmFtZTogXCJFbWJyb2lkZXJ5XCIsIGl0ZW1zOiAtMSB9LFxuICAgICAgeyBjYXRlZ29yeU5hbWU6IFwiSGVhdCBBcHBsaWVkIEdyYXBoaWNzXCIsIGl0ZW1zOiBudWxsIH0sXG4gICAgXSxcbiAgICB7IHBvc2l0aXZlUXVhbnRpdHlPbmx5OiB0cnVlIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZpY2F0aW9uLmtpbmQsIG51bGwpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZGVzdGluYXRpb25NYXBwaW5nRm9yQ2xhc3NpZmljYXRpb24oY2xhc3NpZmljYXRpb24sIG1hcHBpbmdzKSxcbiAgICBudWxsLFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWZhdWx0IHNoYXJlZCBjbGFzc2lmaWNhdGlvbiByZXRhaW5zIFB1cmNoYXNpbmcgemVyby1xdWFudGl0eSBzZW1hbnRpY3NcIiwgKCkgPT4ge1xuICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5RGVjb3JhdGlvbkxpbmVzKFtcbiAgICB7IGNhdGVnb3J5TmFtZTogXCJTY3JlZW4gUHJpbnRpbmdcIiwgaXRlbXM6IDAgfSxcbiAgXSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZpY2F0aW9uLmtpbmQsIFwicHJpbnRcIik7XG59KTtcblxudGVzdChcInVua25vd24gc2F2ZWQgbWFwcGluZ3Mgc3RheSB1bm1hdGNoZWQgaW5zdGVhZCBvZiBzaWxlbnRseSByb3V0aW5nXCIsICgpID0+IHtcbiAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeURlY29yYXRpb25MaW5lcyhcbiAgICBbeyBjYXRlZ29yeU5hbWU6IFwiU2NyZWVuIFByaW50aW5nXCIsIGl0ZW1zOiAxIH1dLFxuICAgIHsgcG9zaXRpdmVRdWFudGl0eU9ubHk6IHRydWUgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoXG4gICAgZGVzdGluYXRpb25NYXBwaW5nRm9yQ2xhc3NpZmljYXRpb24oY2xhc3NpZmljYXRpb24sIFtcbiAgICAgIHsgY2F0ZWdvcnk6IFwiRnV0dXJlIERlY29yYXRpb25cIiwgc3RhdHVzSWQ6IFwiZnV0dXJlXCIsIHN0YXR1c05hbWU6IFwiRnV0dXJlXCIgfSxcbiAgICBdKSxcbiAgICBudWxsLFxuICApO1xufSk7XG5cbnRlc3QoXCJvbGQgY29uZmlncyByZW1haW4gaW4gc2ltcGxlIG1hcHBpbmcgbW9kZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IG5vcm1hbGl6ZUF1dG9QcmludENvbmZpZyh7IGNhdGVnb3J5TWFwcGluZ3M6IG1hcHBpbmdzIH0pO1xuICBhc3NlcnQuZXF1YWwoY29uZmlnLnJvdXRpbmdNb2RlLCBcInNpbXBsZVwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjb25maWcucm91dGluZ1J1bGVzLCBbXSk7XG4gIGFzc2VydC5lcXVhbChjb25maWcuY2F0ZWdvcnlNYXBwaW5ncy5sZW5ndGgsIDMpO1xufSk7XG5cbnRlc3QoXCJjb25kaXRpb25hbCByb3V0aW5nIGlzIGZpcnN0LW1hdGNoLCBleGFjdCBkZWNvcmF0aW9uLCBkdWUsIGFuZCB3aG9sZS13b3JkIE9SIGtleXdvcmRzXCIsICgpID0+IHtcbiAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeURlY29yYXRpb25MaW5lcyhcbiAgICBbeyBjYXRlZ29yeU5hbWU6IFwiU2NyZWVuIFByaW50aW5nXCIsIGl0ZW1zOiAyIH1dLFxuICAgIHsgcG9zaXRpdmVRdWFudGl0eU9ubHk6IHRydWUgfSxcbiAgKTtcbiAgY29uc3QgYmFzZSA9IHtcbiAgICBlbmFibGVkOiB0cnVlLFxuICAgIGR1ZUNvbXBhcmF0b3I6IFwiYXRfbW9zdFwiIGFzIGNvbnN0LFxuICAgIGR1ZUJ1c2luZXNzRGF5czogNSxcbiAgICBuaWNrbmFtZUtleXdvcmRzOiBbXCJEdWVcIiwgXCJSdXNoXCJdLFxuICAgIGRlY29yYXRpb246IFwicHJpbnRcIiBhcyBjb25zdCxcbiAgfTtcbiAgY29uc3QgcnVsZXMgPSBbXG4gICAgeyAuLi5iYXNlLCBpZDogXCJmaXJzdFwiLCBzdGF0dXNJZDogXCJvbmVcIiwgc3RhdHVzTmFtZTogXCJPbmVcIiB9LFxuICAgIHsgLi4uYmFzZSwgaWQ6IFwic2Vjb25kXCIsIHN0YXR1c0lkOiBcInR3b1wiLCBzdGF0dXNOYW1lOiBcIlR3b1wiIH0sXG4gIF07XG4gIGFzc2VydC5lcXVhbChcbiAgICBjb25kaXRpb25hbEF1dG9QcmludERlc3RpbmF0aW9uKHJ1bGVzLCB7XG4gICAgICBjbGFzc2lmaWNhdGlvbixcbiAgICAgIGJ1c2luZXNzRGF5c091dDogNSxcbiAgICAgIG5pY2tuYW1lOiBcIkhBUkQgRFVFIDUvMTJcIixcbiAgICB9KT8uaWQsXG4gICAgXCJmaXJzdFwiLFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgY29uZGl0aW9uYWxBdXRvUHJpbnREZXN0aW5hdGlvbihydWxlcywge1xuICAgICAgY2xhc3NpZmljYXRpb24sXG4gICAgICBidXNpbmVzc0RheXNPdXQ6IDYsXG4gICAgICBuaWNrbmFtZTogXCJSdXNoXCIsXG4gICAgfSksXG4gICAgbnVsbCxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGNvbmRpdGlvbmFsQXV0b1ByaW50RGVzdGluYXRpb24ocnVsZXMsIHtcbiAgICAgIGNsYXNzaWZpY2F0aW9uLFxuICAgICAgYnVzaW5lc3NEYXlzT3V0OiAzLFxuICAgICAgbmlja25hbWU6IFwib3ZlcmR1ZVwiLFxuICAgIH0pLFxuICAgIG51bGwsXG4gICk7XG59KTtcblxudGVzdChcImNvbmRpdGlvbmFsIG5vLW1hdGNoIGRvZXMgbm90IGZhbGwgdGhyb3VnaCBsZWdhY3kgbWFwcGluZ3NcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSBub3JtYWxpemVBdXRvUHJpbnRDb25maWcoe1xuICAgIHJvdXRpbmdNb2RlOiBcImNvbmRpdGlvbmFsXCIsXG4gICAgY2F0ZWdvcnlNYXBwaW5nczogbWFwcGluZ3MsXG4gICAgcm91dGluZ1J1bGVzOiBbXSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChjb25maWcucm91dGluZ01vZGUsIFwiY29uZGl0aW9uYWxcIik7XG4gIGFzc2VydC5lcXVhbChcbiAgICBjb25kaXRpb25hbEF1dG9QcmludERlc3RpbmF0aW9uKGNvbmZpZy5yb3V0aW5nUnVsZXMsIHtcbiAgICAgIGNsYXNzaWZpY2F0aW9uOiBjbGFzc2lmeURlY29yYXRpb25MaW5lcyhcbiAgICAgICAgW3sgY2F0ZWdvcnlOYW1lOiBcIlNjcmVlbiBQcmludGluZ1wiLCBpdGVtczogMSB9XSxcbiAgICAgICAgeyBwb3NpdGl2ZVF1YW50aXR5T25seTogdHJ1ZSB9LFxuICAgICAgKSxcbiAgICAgIGJ1c2luZXNzRGF5c091dDogMSxcbiAgICAgIG5pY2tuYW1lOiBudWxsLFxuICAgIH0pLFxuICAgIG51bGwsXG4gICk7XG59KTtcblxudGVzdChcIm1hbGZvcm1lZCBjb25kaXRpb25hbCBydWxlcyBhcmUgcmVqZWN0ZWQgZHVyaW5nIHBlcnNpc3RlZCBjb25maWcgbm9ybWFsaXphdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IHZhbGlkID0ge1xuICAgIGlkOiBcInZhbGlkXCIsXG4gICAgZW5hYmxlZDogZmFsc2UsXG4gICAgZGVjb3JhdGlvbjogXCJtaXhlZFwiLFxuICAgIGR1ZUNvbXBhcmF0b3I6IG51bGwsXG4gICAgZHVlQnVzaW5lc3NEYXlzOiBudWxsLFxuICAgIG5pY2tuYW1lS2V5d29yZHM6IG51bGwsXG4gICAgc3RhdHVzSWQ6IFwidGFyZ2V0XCIsXG4gICAgc3RhdHVzTmFtZTogXCJUYXJnZXRcIixcbiAgfTtcbiAgY29uc3QgY29uZmlnID0gbm9ybWFsaXplQXV0b1ByaW50Q29uZmlnKHtcbiAgICByb3V0aW5nTW9kZTogXCJjb25kaXRpb25hbFwiLFxuICAgIHJvdXRpbmdSdWxlczogW1xuICAgICAgdmFsaWQsXG4gICAgICB7IC4uLnZhbGlkLCBpZDogXCJiYWQtZGF5c1wiLCBkdWVDb21wYXJhdG9yOiBcImF0X21vc3RcIiwgZHVlQnVzaW5lc3NEYXlzOiAtMSB9LFxuICAgICAgeyAuLi52YWxpZCwgaWQ6IFwiYmFkLWRlY29cIiwgZGVjb3JhdGlvbjogXCJ2aW55bFwiIH0sXG4gICAgXSxcbiAgfSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoY29uZmlnLnJvdXRpbmdSdWxlcywgW3ZhbGlkXSk7XG4gIGFzc2VydC5tYXRjaChcbiAgICB2YWxpZGF0ZUF1dG9QcmludFJvdXRpbmdSdWxlcyhbXG4gICAgICB2YWxpZCxcbiAgICAgIHsgLi4udmFsaWQsIGlkOiBcImJhZFwiLCBkdWVDb21wYXJhdG9yOiBcImF0X21vc3RcIiwgZHVlQnVzaW5lc3NEYXlzOiBudWxsIH0sXG4gICAgXSkgPz8gXCJcIixcbiAgICAvcGFpcmVkIGR1ZSBjb21wYXJhdG9yLyxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHZhbGlkYXRlQXV0b1ByaW50Um91dGluZ1J1bGVzKFt2YWxpZCwgeyAuLi52YWxpZCB9XSksXG4gICAgXCJDb25kaXRpb25hbCBydWxlIGlkcyBtdXN0IGJlIHVuaXF1ZVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJwb3N0LXByaW50IHJvdXRpbmcgYm91bmRhcnkgaW5jbHVkZXMgc3VjY2Vzc2Z1bCBwaHlzaWNhbCBwcmludHMgb25seVwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgc3VjY2Vzc2Z1bFBvc3RQcmludENhbmRpZGF0ZXMoW1xuICAgICAgeyBjYW5kaWRhdGU6IFwic2VudFwiLCBvdXRjb21lOiBcInByaW50ZWRcIiB9LFxuICAgICAgeyBjYW5kaWRhdGU6IFwicHJpbnRlci1lcnJvclwiLCBvdXRjb21lOiBcImZhaWxlZFwiIH0sXG4gICAgICB7IGNhbmRpZGF0ZTogXCJzaW11bGF0aW9uXCIsIG91dGNvbWU6IFwiZHJ5X3J1blwiIH0sXG4gICAgXSksXG4gICAgW1wic2VudFwiXSxcbiAgKTtcbn0pOyIsICIvKipcbiAqIFB1cmUgZGVjb3JhdGlvbiBjbGFzc2lmaWNhdGlvbiBzaGFyZWQgYnkgUHVyY2hhc2luZyBhbmQgYXV0by1wcmludC5cbiAqXG4gKiBUaGUgbGluZS1pdGVtIGNhdGVnb3J5IGlzIHRoZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHByb2R1Y3Rpb24gZGVjb3JhdGlvbi5cbiAqIEltcHJpbnRzIGFyZSBkZWxpYmVyYXRlbHkgbm90IGNvbnN1bHRlZCBoZXJlOiBhbiBvcmRlciBjYW4gaGF2ZSBhIHZhbGlkXG4gKiBkZWNvcmF0aW9uIGNhdGVnb3J5IGV2ZW4gd2hlbiBpdHMgaW1wcmludHMgYXJlIGVtcHR5IG9yIHdlcmUgbm90IHN5bmNlZC5cbiAqL1xuXG5leHBvcnQgdHlwZSBEZWNvR3JvdXAgPSBcInByaW50XCIgfCBcImhlYXRcIiB8IFwiZW1icm9pZGVyeVwiO1xuZXhwb3J0IHR5cGUgRGVjb3JhdGlvbktpbmQgPSBEZWNvR3JvdXAgfCBcIm1peGVkXCI7XG5cbmV4cG9ydCBjb25zdCBERUNPX0dST1VQUzogcmVhZG9ubHkgRGVjb0dyb3VwW10gPSBbXG4gIFwicHJpbnRcIixcbiAgXCJoZWF0XCIsXG4gIFwiZW1icm9pZGVyeVwiLFxuXTtcblxuLyoqIFN0YWJsZSBsYWJlbHMgdXNlZCBieSB0aGUgYXV0by1wcmludCBkZXN0aW5hdGlvbiBlZGl0b3IvQVBJLiAqL1xuZXhwb3J0IGNvbnN0IERFQ09SQVRJT05fQ0FURUdPUllfTEFCRUxTID0gW1xuICBcIlNjcmVlbiBQcmludGluZ1wiLFxuICBcIkhlYXQgQXBwbGllZCBHcmFwaGljc1wiLFxuICBcIkVtYnJvaWRlcnlcIixcbiAgXCJNaXhlZCBEZWNvcmF0aW9uXCIsXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIEtlZXAgdGhpcyBsaW5lLWNhdGVnb3J5IG1hcCBhbGlnbmVkIHdpdGggUHVyY2hhc2luZydzIG9yaWdpbmFsXG4gKiBDQVRFR09SWV9UT19HUk9VUC4gQWxpYXNlcyBiZWxvdyBhcmUgZm9yIHNhdmVkIGF1dG8tcHJpbnQgZGVzdGluYXRpb25cbiAqIG1hcHBpbmdzIG9ubHk7IGFkZGluZyBhbGlhc2VzIGhlcmUgd291bGQgY2hhbmdlIFB1cmNoYXNpbmcgbWF0Y2hpbmcuXG4gKi9cbmNvbnN0IExJTkVfQ0FURUdPUllfVE9fR1JPVVA6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIERlY29Hcm91cD4+ID0ge1xuICBcInNjcmVlbiBwcmludGluZ1wiOiBcInByaW50XCIsXG4gIFwiaGVhdCBhcHBsaWVkIGdyYXBoaWNzXCI6IFwiaGVhdFwiLFxuICBcImhlYXQgYXBwbGllZCBncmFwaGljcyAtIHBlcnNvbmFsaXphdGlvbnNcIjogXCJoZWF0XCIsXG4gIGVtYnJvaWRlcnk6IFwiZW1icm9pZGVyeVwiLFxuICBcImVtYnJvaWRlcnkgLSBwZXJzb25hbGl6YXRpb25zXCI6IFwiZW1icm9pZGVyeVwiLFxuICBcImVtYnJvaWRlcnkgLSBzZXQgdXAvZGlnaXRpemluZ1wiOiBcImVtYnJvaWRlcnlcIixcbn07XG5cbmNvbnN0IENBVEVHT1JZX0FMSUFTRVM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIERlY29Hcm91cD4+ID0ge1xuICBcInNjcmVlbiBwcmludFwiOiBcInByaW50XCIsXG4gIHNjcmVlbnByaW50aW5nOiBcInByaW50XCIsXG4gIFwic2NyZWVuIHByaW50c1wiOiBcInByaW50XCIsXG4gIHNpbGtzY3JlZW46IFwicHJpbnRcIixcbiAgXCJzaWxrIHNjcmVlblwiOiBcInByaW50XCIsXG4gIHNwOiBcInByaW50XCIsXG4gIFwiaGVhdCBhcHBsaWVkIGdyYXBoaWNcIjogXCJoZWF0XCIsXG4gIFwiaGVhdCBhcHBsaWVkIGdyYXBoaWNzIC0gcGVyc29uYWxpemF0aW9uXCI6IFwiaGVhdFwiLFxuICBcImhlYXQgYXBwbGllZFwiOiBcImhlYXRcIixcbiAgXCJoZWF0IHByZXNzXCI6IFwiaGVhdFwiLFxuICBkdGY6IFwiaGVhdFwiLFxuICBcImVtYnJvaWRlcnkgLSBwZXJzb25hbGl6YXRpb25cIjogXCJlbWJyb2lkZXJ5XCIsXG4gIFwiZW1icm9pZGVyeSAtIHNldHVwL2RpZ2l0aXppbmdcIjogXCJlbWJyb2lkZXJ5XCIsXG4gIFwiZW1icm9pZGVyeSAtIHNldCB1cFwiOiBcImVtYnJvaWRlcnlcIixcbiAgXCJlbWJyb2lkZXJ5IC0gZGlnaXRpemluZ1wiOiBcImVtYnJvaWRlcnlcIixcbiAgZW1iOiBcImVtYnJvaWRlcnlcIixcbn07XG5cbmNvbnN0IE1JWEVEX0NBVEVHT1JZX0FMSUFTRVMgPSBuZXcgU2V0KFtcbiAgXCJtaXhlZCBkZWNvcmF0aW9uXCIsXG4gIFwibWl4ZWQgZGVjb3JhdGlvbnNcIixcbl0pO1xuXG5leHBvcnQgaW50ZXJmYWNlIERlY29yYXRpb25MaW5lIHtcbiAgY2F0ZWdvcnlOYW1lOiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogUXVhbnRpdHkgcmVwcmVzZW50ZWQgYnkgdGhpcyBsaW5lLiBBIG1pc3Npbmcvbm9uLXBvc2l0aXZlIHF1YW50aXR5IGlzXG4gICAqIGlnbm9yZWQgd2hlbiBwb3NpdGl2ZVF1YW50aXR5T25seSBpcyByZXF1ZXN0ZWQuXG4gICAqL1xuICBpdGVtcz86IG51bWJlciB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVjb3JhdGlvbkNsYXNzaWZpY2F0aW9uIHtcbiAgZ3JvdXBzOiBTZXQ8RGVjb0dyb3VwPjtcbiAgbWl4ZWQ6IGJvb2xlYW47XG4gIC8qKiBudWxsIGZvciBubyByZWNvZ25pemVkIHBvc2l0aXZlLXF1YW50aXR5IGRlY29yYXRpb24gbGluZXMuICovXG4gIGtpbmQ6IERlY29yYXRpb25LaW5kIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEZWNvcmF0aW9uRGVzdGluYXRpb25NYXBwaW5nIHtcbiAgY2F0ZWdvcnk6IHN0cmluZztcbiAgc3RhdHVzSWQ6IHN0cmluZztcbiAgc3RhdHVzTmFtZTogc3RyaW5nO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplRGVjb3JhdGlvbkNhdGVnb3J5KG5hbWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICByZXR1cm4gKG5hbWUgPz8gXCJcIilcbiAgICAudHJpbSgpXG4gICAgLnRvTG93ZXJDYXNlKClcbiAgICAucmVwbGFjZSgvW1x1MjAxMFx1MjAxMVx1MjAxMlx1MjAxM1x1MjAxNFx1MjAxNV0vZywgXCItXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpO1xufVxuXG4vKipcbiAqIFJlc29sdmUgYSBzYXZlZCBtYXBwaW5nIG9yIGEgbGluZS1pdGVtIGNhdGVnb3J5IHRvIGl0cyBkZXN0aW5hdGlvbiBncm91cC5cbiAqIFVua25vd24gdmFsdWVzIGludGVudGlvbmFsbHkgcmV0dXJuIG51bGw6IGFjY2VwdGluZyBhcmJpdHJhcnkgc3Vic3RyaW5nc1xuICogd291bGQgc2lsZW50bHkgcm91dGUgZnV0dXJlIGNhdGVnb3JpZXMgdG8gdGhlIHdyb25nIGRlc3RpbmF0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVjb3JhdGlvbkdyb3VwRm9yQ2F0ZWdvcnkoXG4gIGNhdGVnb3J5OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuKTogRGVjb0dyb3VwIHwgbnVsbCB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVEZWNvcmF0aW9uQ2F0ZWdvcnkoY2F0ZWdvcnkpO1xuICByZXR1cm4gTElORV9DQVRFR09SWV9UT19HUk9VUFtub3JtYWxpemVkXSA/PyBDQVRFR09SWV9BTElBU0VTW25vcm1hbGl6ZWRdID8/IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWNvcmF0aW9uS2luZEZvckNhdGVnb3J5KFxuICBjYXRlZ29yeTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IERlY29yYXRpb25LaW5kIHwgbnVsbCB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVEZWNvcmF0aW9uQ2F0ZWdvcnkoY2F0ZWdvcnkpO1xuICBpZiAoTUlYRURfQ0FURUdPUllfQUxJQVNFUy5oYXMobm9ybWFsaXplZCkpIHJldHVybiBcIm1peGVkXCI7XG4gIHJldHVybiBMSU5FX0NBVEVHT1JZX1RPX0dST1VQW25vcm1hbGl6ZWRdID8/IENBVEVHT1JZX0FMSUFTRVNbbm9ybWFsaXplZF0gPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gbGluZURlY29yYXRpb25LaW5kKFxuICBjYXRlZ29yeTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IERlY29yYXRpb25LaW5kIHwgbnVsbCB7XG4gIC8vIFRoaXMgaW50ZW50aW9uYWxseSBtaXJyb3JzIFB1cmNoYXNpbmcncyBoaXN0b3JpY2FsIHRyaW0gKyBsb3dlcmNhc2VcbiAgLy8gbm9ybWFsaXphdGlvbiBpbnN0ZWFkIG9mIGJyb2FkZW5pbmcgaXRzIGxpbmUtY2F0ZWdvcnkgbWF0Y2hlcy5cbiAgY29uc3Qgbm9ybWFsaXplZCA9IChjYXRlZ29yeSA/PyBcIlwiKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwibWl4ZWQgZGVjb3JhdGlvblwiKSByZXR1cm4gXCJtaXhlZFwiO1xuICByZXR1cm4gTElORV9DQVRFR09SWV9UT19HUk9VUFtub3JtYWxpemVkXSA/PyBudWxsO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IHJlY29nbml6ZWQgZGVjb3JhdGlvbiBsaW5lcy4gUHVyY2hhc2luZyBwYXNzZXMgdGhlIGhpc3RvcmljYWxcbiAqIGluY2x1ZGUtemVybyBiZWhhdmlvciAodGhlIGRlZmF1bHQpIHRvIHByZXNlcnZlIGl0cyBleGlzdGluZyBzZW1hbnRpY3M7XG4gKiBhdXRvLXByaW50IHJlcXVlc3RzIHBvc2l0aXZlUXVhbnRpdHlPbmx5IHNvIHN0YWxlIHplcm8tcXVhbnRpdHkgcm93cyBjYW5ub3RcbiAqIHJvdXRlIGFuIG9yZGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlEZWNvcmF0aW9uTGluZXMoXG4gIGxpbmVzOiByZWFkb25seSBEZWNvcmF0aW9uTGluZVtdLFxuICBvcHRpb25zOiB7IHBvc2l0aXZlUXVhbnRpdHlPbmx5PzogYm9vbGVhbiB9ID0ge30sXG4pOiBEZWNvcmF0aW9uQ2xhc3NpZmljYXRpb24ge1xuICBjb25zdCBncm91cHMgPSBuZXcgU2V0PERlY29Hcm91cD4oKTtcbiAgbGV0IGV4cGxpY2l0TWl4ZWQgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBpZiAob3B0aW9ucy5wb3NpdGl2ZVF1YW50aXR5T25seSAmJiAhKGxpbmUuaXRlbXMgIT0gbnVsbCAmJiBsaW5lLml0ZW1zID4gMCkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBraW5kID0gbGluZURlY29yYXRpb25LaW5kKGxpbmUuY2F0ZWdvcnlOYW1lKTtcbiAgICBpZiAoa2luZCA9PT0gXCJtaXhlZFwiKSB7XG4gICAgICBleHBsaWNpdE1peGVkID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGtpbmQpIHtcbiAgICAgIGdyb3Vwcy5hZGQoa2luZCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgbWl4ZWQgPSBleHBsaWNpdE1peGVkIHx8IGdyb3Vwcy5zaXplID4gMTtcbiAgY29uc3Qga2luZDogRGVjb3JhdGlvbktpbmQgfCBudWxsID0gbWl4ZWRcbiAgICA/IFwibWl4ZWRcIlxuICAgIDogZ3JvdXBzLnNpemUgPT09IDFcbiAgICAgID8gWy4uLmdyb3Vwc11bMF1cbiAgICAgIDogbnVsbDtcbiAgcmV0dXJuIHsgZ3JvdXBzLCBtaXhlZCwga2luZCB9O1xufVxuXG4vKipcbiAqIFNlbGVjdCB0aGUgZmlyc3Qgc2F2ZWQgZGVzdGluYXRpb24gbWFwcGluZyBmb3IgdGhlIGV4YWN0IGNsYXNzaWZpZWQga2luZC5cbiAqIFRoaXMgZGVsaWJlcmF0ZWx5IGRvZXMgbm90IGZhbGwgYmFjayBmcm9tIG1peGVkIHRvIGEgc2luZ2xlLW1ldGhvZFxuICogbWFwcGluZywgYW5kIHVua25vd24gc2F2ZWQgY2F0ZWdvcmllcyBuZXZlciBtYXRjaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlc3RpbmF0aW9uTWFwcGluZ0ZvckNsYXNzaWZpY2F0aW9uPFxuICBUIGV4dGVuZHMgRGVjb3JhdGlvbkRlc3RpbmF0aW9uTWFwcGluZyxcbj4oXG4gIGNsYXNzaWZpY2F0aW9uOiBEZWNvcmF0aW9uQ2xhc3NpZmljYXRpb24sXG4gIG1hcHBpbmdzOiByZWFkb25seSBUW10sXG4pOiBUIHwgbnVsbCB7XG4gIGlmICghY2xhc3NpZmljYXRpb24ua2luZCkgcmV0dXJuIG51bGw7XG4gIGZvciAoY29uc3QgbWFwcGluZyBvZiBtYXBwaW5ncykge1xuICAgIGlmIChkZWNvcmF0aW9uS2luZEZvckNhdGVnb3J5KG1hcHBpbmcuY2F0ZWdvcnkpID09PSBjbGFzc2lmaWNhdGlvbi5raW5kKSB7XG4gICAgICByZXR1cm4gbWFwcGluZztcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59IiwgImltcG9ydCB0eXBlIHsgRGVjb0dyb3VwIH0gZnJvbSBcIi4vZGVjb3JhdGlvbkNsYXNzaWZpZXJcIjtcblxuZXhwb3J0IGludGVyZmFjZSBSdWxlT3JkZXJDb21wb3NpdGlvbiB7XG4gIGdyb3VwczogU2V0PERlY29Hcm91cD47XG4gIG1peGVkOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERlY29EdWVSdWxlU2hhcGUge1xuICBzcGVjaWFsTWl4ZWREZWNvOiBib29sZWFuO1xuICBkZWNvR3JvdXA6IHN0cmluZyB8IG51bGw7XG4gIGR1ZUNvbXBhcmF0b3I6IHN0cmluZyB8IG51bGw7XG4gIGR1ZUJ1c2luZXNzRGF5czogbnVtYmVyIHwgbnVsbDtcbiAgbmlja25hbWVLZXl3b3Jkcz86IHVua25vd247XG59XG5cbmNvbnN0IGVzY2FwZVJlZ0V4cCA9IChzOiBzdHJpbmcpOiBzdHJpbmcgPT4gcy5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG5cbmV4cG9ydCBmdW5jdGlvbiBuaWNrbmFtZUhhc0tleXdvcmQobmlja25hbWU6IHN0cmluZyB8IG51bGwsIGtleXdvcmRzOiBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICBpZiAoIW5pY2tuYW1lKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBrZXl3b3Jkcy5zb21lKChrdykgPT5cbiAgICBuZXcgUmVnRXhwKGAoXnxbXlxcXFxwe0x9XFxcXHB7Tn1dKSR7ZXNjYXBlUmVnRXhwKGt3KX0oW15cXFxccHtMfVxcXFxwe059XXwkKWAsIFwiaXVcIikudGVzdChuaWNrbmFtZSksXG4gICk7XG59XG5cbmZ1bmN0aW9uIHJ1bGVLZXl3b3JkcyhyYXc6IHVua25vd24pOiBzdHJpbmdbXSB8IG51bGwge1xuICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHdvcmRzID0gcmF3LmZpbHRlcigod29yZCk6IHdvcmQgaXMgc3RyaW5nID0+IHR5cGVvZiB3b3JkID09PSBcInN0cmluZ1wiICYmIHdvcmQudHJpbSgpICE9PSBcIlwiKTtcbiAgcmV0dXJuIHdvcmRzLmxlbmd0aCA/IHdvcmRzIDogbnVsbDtcbn1cblxuLyoqIFNoYXJlZCBwdXJlIG1hdGNoZXIgZm9yIFB1cmNoYXNpbmcgYW5kIHN1Y2Nlc3NmdWwtcHJpbnQgcm91dGluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydWxlTWF0Y2hlcyhcbiAgcnVsZTogRGVjb0R1ZVJ1bGVTaGFwZSxcbiAgY29tcDogUnVsZU9yZGVyQ29tcG9zaXRpb24sXG4gIGJ1c2luZXNzRGF5c091dDogbnVtYmVyIHwgbnVsbCxcbiAgbmlja25hbWU6IHN0cmluZyB8IG51bGwgPSBudWxsLFxuKTogYm9vbGVhbiB7XG4gIGlmIChydWxlLnNwZWNpYWxNaXhlZERlY28pIHtcbiAgICBpZiAoIWNvbXAubWl4ZWQpIHJldHVybiBmYWxzZTtcbiAgfSBlbHNlIGlmIChydWxlLmRlY29Hcm91cCkge1xuICAgIGlmIChjb21wLm1peGVkKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGNvbXAuZ3JvdXBzLnNpemUgIT09IDEgfHwgIWNvbXAuZ3JvdXBzLmhhcyhydWxlLmRlY29Hcm91cCBhcyBEZWNvR3JvdXApKSByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHJ1bGUuZHVlQ29tcGFyYXRvciAmJiBydWxlLmR1ZUJ1c2luZXNzRGF5cyAhPSBudWxsKSB7XG4gICAgaWYgKGJ1c2luZXNzRGF5c091dCA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKHJ1bGUuZHVlQ29tcGFyYXRvciA9PT0gXCJtb3JlX3RoYW5cIiAmJiBidXNpbmVzc0RheXNPdXQgPD0gcnVsZS5kdWVCdXNpbmVzc0RheXMpIHJldHVybiBmYWxzZTtcbiAgICBpZiAocnVsZS5kdWVDb21wYXJhdG9yID09PSBcImF0X21vc3RcIiAmJiBidXNpbmVzc0RheXNPdXQgPiBydWxlLmR1ZUJ1c2luZXNzRGF5cykgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IGtleXdvcmRzID0gcnVsZUtleXdvcmRzKHJ1bGUubmlja25hbWVLZXl3b3Jkcyk7XG4gIHJldHVybiAha2V5d29yZHMgfHwgbmlja25hbWVIYXNLZXl3b3JkKG5pY2tuYW1lLCBrZXl3b3Jkcyk7XG59IiwgImltcG9ydCB7IHJ1bGVNYXRjaGVzLCB0eXBlIFJ1bGVPcmRlckNvbXBvc2l0aW9uIH0gZnJvbSBcIi4uLy4uL3B1cmNoYXNpbmcvcnVsZU1hdGNoaW5nXCI7XG5pbXBvcnQgdHlwZSB7IERlY29yYXRpb25DbGFzc2lmaWNhdGlvbiB9IGZyb20gXCIuLi8uLi9wdXJjaGFzaW5nL2RlY29yYXRpb25DbGFzc2lmaWVyXCI7XG5pbXBvcnQgdHlwZSB7IEF1dG9QcmludFJvdXRpbmdSdWxlIH0gZnJvbSBcIi4vY29uZmlnVmFsaWRhdGlvblwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9QcmludFJvdXRpbmdDYW5kaWRhdGUge1xuICBjbGFzc2lmaWNhdGlvbjogRGVjb3JhdGlvbkNsYXNzaWZpY2F0aW9uO1xuICBidXNpbmVzc0RheXNPdXQ6IG51bWJlciB8IG51bGw7XG4gIG5pY2tuYW1lOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3VjY2Vzc2Z1bFBvc3RQcmludENhbmRpZGF0ZXM8VD4oXG4gIG91dGNvbWVzOiB7IGNhbmRpZGF0ZTogVDsgb3V0Y29tZTogXCJwcmludGVkXCIgfCBcImZhaWxlZFwiIHwgXCJkcnlfcnVuXCIgfVtdLFxuKTogVFtdIHtcbiAgcmV0dXJuIG91dGNvbWVzXG4gICAgLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5vdXRjb21lID09PSBcInByaW50ZWRcIilcbiAgICAubWFwKChpdGVtKSA9PiBpdGVtLmNhbmRpZGF0ZSk7XG59XG5cbi8qKiBQdXJlIGZpcnN0LW1hdGNoIGV2YWx1YXRvci4gUnVsZXMgYXJlIGFscmVhZHkgc3RvcmVkIGluIHByaW9yaXR5IG9yZGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbmRpdGlvbmFsQXV0b1ByaW50RGVzdGluYXRpb24oXG4gIHJ1bGVzOiBBdXRvUHJpbnRSb3V0aW5nUnVsZVtdLFxuICBjYW5kaWRhdGU6IEF1dG9QcmludFJvdXRpbmdDYW5kaWRhdGUsXG4pOiBBdXRvUHJpbnRSb3V0aW5nUnVsZSB8IG51bGwge1xuICBjb25zdCBjb21wOiBSdWxlT3JkZXJDb21wb3NpdGlvbiA9IHtcbiAgICBncm91cHM6IGNhbmRpZGF0ZS5jbGFzc2lmaWNhdGlvbi5ncm91cHMsXG4gICAgbWl4ZWQ6IGNhbmRpZGF0ZS5jbGFzc2lmaWNhdGlvbi5taXhlZCxcbiAgfTtcbiAgcmV0dXJuIChcbiAgICBydWxlcy5maW5kKChydWxlKSA9PiB7XG4gICAgICBpZiAoIXJ1bGUuZW5hYmxlZCkgcmV0dXJuIGZhbHNlO1xuICAgICAgcmV0dXJuIHJ1bGVNYXRjaGVzKFxuICAgICAgICB7XG4gICAgICAgICAgc3BlY2lhbE1peGVkRGVjbzogcnVsZS5kZWNvcmF0aW9uID09PSBcIm1peGVkXCIsXG4gICAgICAgICAgZGVjb0dyb3VwOlxuICAgICAgICAgICAgcnVsZS5kZWNvcmF0aW9uID09PSBcImFueVwiIHx8IHJ1bGUuZGVjb3JhdGlvbiA9PT0gXCJtaXhlZFwiXG4gICAgICAgICAgICAgID8gbnVsbFxuICAgICAgICAgICAgICA6IHJ1bGUuZGVjb3JhdGlvbixcbiAgICAgICAgICBkdWVDb21wYXJhdG9yOiBydWxlLmR1ZUNvbXBhcmF0b3IsXG4gICAgICAgICAgZHVlQnVzaW5lc3NEYXlzOiBydWxlLmR1ZUJ1c2luZXNzRGF5cyxcbiAgICAgICAgICBuaWNrbmFtZUtleXdvcmRzOiBydWxlLm5pY2tuYW1lS2V5d29yZHMsXG4gICAgICAgIH0sXG4gICAgICAgIGNvbXAsXG4gICAgICAgIGNhbmRpZGF0ZS5idXNpbmVzc0RheXNPdXQsXG4gICAgICAgIGNhbmRpZGF0ZS5uaWNrbmFtZSxcbiAgICAgICk7XG4gICAgfSkgPz8gbnVsbFxuICApO1xufSIsICIvKipcbiAqIFB1cmUgYXV0by1wcmludCBjb25maWd1cmF0aW9uIHZhbGlkYXRpb24gYW5kIG5vcm1hbGl6YXRpb24uXG4gKlxuICogS2VlcCB0aGlzIG1vZHVsZSBmcmVlIG9mIGRhdGFiYXNlIGltcG9ydHMgc28gc2NoZWR1bGUgYmVoYXZpb3IgY2FuIGJlXG4gKiB0ZXN0ZWQgb2ZmbGluZSBhbmQgb2xkIGFwcF9zZXR0aW5ncyByb3dzIGNhbiBiZSB1cGdyYWRlZCBvbiByZWFkLlxuICovXG5cbmV4cG9ydCBjb25zdCBBVVRPX1BSSU5UX1NDSEVEVUxFX01PREVTID0gW1wiaW50ZXJ2YWxcIiwgXCJkYWlseVwiXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIEF1dG9QcmludFNjaGVkdWxlTW9kZSA9ICh0eXBlb2YgQVVUT19QUklOVF9TQ0hFRFVMRV9NT0RFUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfREFJTFlfVElNRVMgPSBbXCIwNjowMFwiXSBhcyBjb25zdDtcbmV4cG9ydCBjb25zdCBNQVhfREFJTFlfVElNRVMgPSAxMjtcbmV4cG9ydCBjb25zdCBEQUlMWV9USU1FX1BBVFRFUk4gPSAvXig/OlswMV1bMC05XXwyWzAtM10pOlswLTVdWzAtOV0kLztcblxuZXhwb3J0IGludGVyZmFjZSBDYXRlZ29yeU1hcHBpbmcge1xuICAvKiogRGVjb3JhdGlvbiBjYXRlZ29yeS9ncm91cCBsYWJlbCB1c2VkIGZvciBhIHBvc3QtcHJpbnQgZGVzdGluYXRpb24uICovXG4gIGNhdGVnb3J5OiBzdHJpbmc7XG4gIC8qKiBQcmludGF2byBzdGF0dXMgdG8gbW92ZSB0aGUgb3JkZXIgdG8gYWZ0ZXIgYSBzdWNjZXNzZnVsIHByaW50LiAqL1xuICBzdGF0dXNJZDogc3RyaW5nO1xuICBzdGF0dXNOYW1lOiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIEF1dG9QcmludFJvdXRpbmdNb2RlID0gXCJzaW1wbGVcIiB8IFwiY29uZGl0aW9uYWxcIjtcbmV4cG9ydCB0eXBlIEF1dG9QcmludERlY29yYXRpb24gPSBcImFueVwiIHwgXCJwcmludFwiIHwgXCJoZWF0XCIgfCBcImVtYnJvaWRlcnlcIiB8IFwibWl4ZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBdXRvUHJpbnRSb3V0aW5nUnVsZSB7XG4gIGlkOiBzdHJpbmc7XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIGRlY29yYXRpb246IEF1dG9QcmludERlY29yYXRpb247XG4gIGR1ZUNvbXBhcmF0b3I6IFwibW9yZV90aGFuXCIgfCBcImF0X21vc3RcIiB8IG51bGw7XG4gIGR1ZUJ1c2luZXNzRGF5czogbnVtYmVyIHwgbnVsbDtcbiAgbmlja25hbWVLZXl3b3Jkczogc3RyaW5nW10gfCBudWxsO1xuICBzdGF0dXNJZDogc3RyaW5nO1xuICBzdGF0dXNOYW1lOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1ByaW50Q29uZmlnIHtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgLyoqIFdoaWNoIG9uZSBzY2hlZHVsZSBpcyBhY3RpdmU6IGludGVydmFsIG9yIGRhaWx5LiAqL1xuICBzY2hlZHVsZU1vZGU6IEF1dG9QcmludFNjaGVkdWxlTW9kZTtcbiAgLyoqIEhvdXJzIGJldHdlZW4gc2NoZWR1bGVkIHJ1bnMgKDFcdTIwMTMyNCkgaW4gaW50ZXJ2YWwgbW9kZS4gKi9cbiAgc2NoZWR1bGVIb3VyczogbnVtYmVyO1xuICAvKiogRWFzdGVybiBsb2NhbCB0aW1lcyBhdCB3aGljaCBkYWlseSBtb2RlIG1heSBydW4gKG1heGltdW0gMTIpLiAqL1xuICBkYWlseVRpbWVzOiBzdHJpbmdbXTtcbiAgLyoqIFByaW50YXZvIHN0YXR1cyBpZHMgdGhlIGVuZ2luZSBwdWxscyBvcmRlcnMgZnJvbS4gKi9cbiAgc291cmNlU3RhdHVzSWRzOiBzdHJpbmdbXTtcbiAgLyoqIFN0YXR1cyBzZXQgb24gYW4gb3JkZXIgd2hlbiBpdHMgcHJpbnQgZmFpbHMgKG51bGwgPSBsZWF2ZSBhbG9uZSkuICovXG4gIGVycm9yU3RhdHVzSWQ6IHN0cmluZyB8IG51bGw7XG4gIGVycm9yU3RhdHVzTmFtZTogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFByaW50Tm9kZSBwcmludGVyIGZvciB3b3Jrb3JkZXJzLiAqL1xuICBwcmludGVySWQ6IHN0cmluZyB8IG51bGw7XG4gIHByaW50ZXJOYW1lOiBzdHJpbmcgfCBudWxsO1xuICBjb3BpZXM6IG51bWJlcjtcbiAgLyoqIFNpbXVsYXRlIHJ1bnMgd2l0aG91dCBzZW5kaW5nIGFueXRoaW5nIHRvIFByaW50Tm9kZS4gKi9cbiAgZHJ5UnVuOiBib29sZWFuO1xuICAvKiogSGlkZSBQcmludGF2byBhdHRhY2htZW50L21vY2t1cCBibG9ja3MgZnJvbSBhdXRvLXByaW50ZWQgd29ya29yZGVycy4gKi9cbiAgZXhjbHVkZUF0dGFjaG1lbnRzOiBib29sZWFuO1xuICAvKiogRGVjb3JhdGlvbiBjYXRlZ29yeS9ncm91cCBcdTIxOTIgcG9zdC1wcmludCB0YXJnZXQgc3RhdHVzLiAqL1xuICBjYXRlZ29yeU1hcHBpbmdzOiBDYXRlZ29yeU1hcHBpbmdbXTtcbiAgLyoqIFNlbGVjdHMgZWl0aGVyIGxlZ2FjeSBtYXBwaW5ncyBvciB0aGUgaW5kZXBlbmRlbnQsIHByaW9yaXRpemVkIHJ1bGUgbGlzdC4gKi9cbiAgcm91dGluZ01vZGU6IEF1dG9QcmludFJvdXRpbmdNb2RlO1xuICByb3V0aW5nUnVsZXM6IEF1dG9QcmludFJvdXRpbmdSdWxlW107XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX0FVVE9fUFJJTlRfQ09ORklHOiBBdXRvUHJpbnRDb25maWcgPSB7XG4gIGVuYWJsZWQ6IGZhbHNlLFxuICBzY2hlZHVsZU1vZGU6IFwiaW50ZXJ2YWxcIixcbiAgc2NoZWR1bGVIb3VyczogNixcbiAgZGFpbHlUaW1lczogWy4uLkRFRkFVTFRfREFJTFlfVElNRVNdLFxuICBzb3VyY2VTdGF0dXNJZHM6IFtdLFxuICBlcnJvclN0YXR1c0lkOiBudWxsLFxuICBlcnJvclN0YXR1c05hbWU6IG51bGwsXG4gIHByaW50ZXJJZDogbnVsbCxcbiAgcHJpbnRlck5hbWU6IG51bGwsXG4gIGNvcGllczogMSxcbiAgZHJ5UnVuOiB0cnVlLFxuICBleGNsdWRlQXR0YWNobWVudHM6IGZhbHNlLFxuICBjYXRlZ29yeU1hcHBpbmdzOiBbXSxcbiAgcm91dGluZ01vZGU6IFwic2ltcGxlXCIsXG4gIHJvdXRpbmdSdWxlczogW10sXG59O1xuXG5jb25zdCBERUNPUkFUSU9OUyA9IG5ldyBTZXQoW1wiYW55XCIsIFwicHJpbnRcIiwgXCJoZWF0XCIsIFwiZW1icm9pZGVyeVwiLCBcIm1peGVkXCJdKTtcbmNvbnN0IENPTVBBUkFUT1JTID0gbmV3IFNldChbXCJtb3JlX3RoYW5cIiwgXCJhdF9tb3N0XCJdKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzVmFsaWRBdXRvUHJpbnRSb3V0aW5nUnVsZSh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIEF1dG9QcmludFJvdXRpbmdSdWxlIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgciA9IHZhbHVlIGFzIFBhcnRpYWw8QXV0b1ByaW50Um91dGluZ1J1bGU+O1xuICBpZiAoXG4gICAgdHlwZW9mIHIuaWQgIT09IFwic3RyaW5nXCIgfHxcbiAgICAhci5pZCB8fFxuICAgIHR5cGVvZiByLmVuYWJsZWQgIT09IFwiYm9vbGVhblwiIHx8XG4gICAgIURFQ09SQVRJT05TLmhhcyhTdHJpbmcoci5kZWNvcmF0aW9uKSkgfHxcbiAgICB0eXBlb2Ygci5zdGF0dXNJZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICFyLnN0YXR1c0lkIHx8XG4gICAgdHlwZW9mIHIuc3RhdHVzTmFtZSAhPT0gXCJzdHJpbmdcIlxuICApIHJldHVybiBmYWxzZTtcbiAgaWYgKChyLmR1ZUNvbXBhcmF0b3IgPT0gbnVsbCkgIT09IChyLmR1ZUJ1c2luZXNzRGF5cyA9PSBudWxsKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoXG4gICAgci5kdWVDb21wYXJhdG9yICE9IG51bGwgJiZcbiAgICAoIUNPTVBBUkFUT1JTLmhhcyhyLmR1ZUNvbXBhcmF0b3IpIHx8XG4gICAgICAhTnVtYmVyLmlzSW50ZWdlcihyLmR1ZUJ1c2luZXNzRGF5cykgfHxcbiAgICAgIChyLmR1ZUJ1c2luZXNzRGF5cyBhcyBudW1iZXIpIDwgMClcbiAgKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAoXG4gICAgci5uaWNrbmFtZUtleXdvcmRzID09IG51bGwgfHxcbiAgICAoQXJyYXkuaXNBcnJheShyLm5pY2tuYW1lS2V5d29yZHMpICYmXG4gICAgICByLm5pY2tuYW1lS2V5d29yZHMubGVuZ3RoIDw9IDIwICYmXG4gICAgICByLm5pY2tuYW1lS2V5d29yZHMuZXZlcnkoXG4gICAgICAgICh3b3JkKSA9PiB0eXBlb2Ygd29yZCA9PT0gXCJzdHJpbmdcIiAmJiB3b3JkLnRyaW0oKS5sZW5ndGggPiAwICYmIHdvcmQubGVuZ3RoIDw9IDYwLFxuICAgICAgKSlcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlQXV0b1ByaW50Um91dGluZ1J1bGVzKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiBcIkNvbmRpdGlvbmFsIHJ1bGVzIG11c3QgYmUgYSBsaXN0XCI7XG4gIGlmICh2YWx1ZS5zb21lKChydWxlKSA9PiAhaXNWYWxpZEF1dG9QcmludFJvdXRpbmdSdWxlKHJ1bGUpKSkge1xuICAgIHJldHVybiBcIkVhY2ggY29uZGl0aW9uYWwgcnVsZSBuZWVkcyBhIHZhbGlkIGRlY29yYXRpb24sIHBhaXJlZCBkdWUgY29tcGFyYXRvciBhbmQgbm9uLW5lZ2F0aXZlIGJ1c2luZXNzLWRheSBjb3VudCwgdXAgdG8gMjAgbmlja25hbWUga2V5d29yZHMsIGFuZCBhIHRhcmdldCBzdGF0dXNcIjtcbiAgfVxuICBjb25zdCBpZHMgPSB2YWx1ZS5tYXAoKHJ1bGUpID0+IChydWxlIGFzIEF1dG9QcmludFJvdXRpbmdSdWxlKS5pZCk7XG4gIGlmIChuZXcgU2V0KGlkcykuc2l6ZSAhPT0gaWRzLmxlbmd0aCkgcmV0dXJuIFwiQ29uZGl0aW9uYWwgcnVsZSBpZHMgbXVzdCBiZSB1bmlxdWVcIjtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0F1dG9QcmludFNjaGVkdWxlTW9kZShcbiAgdmFsdWU6IHVua25vd24sXG4pOiB2YWx1ZSBpcyBBdXRvUHJpbnRTY2hlZHVsZU1vZGUge1xuICByZXR1cm4gdmFsdWUgPT09IFwiaW50ZXJ2YWxcIiB8fCB2YWx1ZSA9PT0gXCJkYWlseVwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNEYWlseVRpbWUodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIERBSUxZX1RJTUVfUEFUVEVSTi50ZXN0KHZhbHVlKTtcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgcGVyc2lzdGVkIHZhbHVlcyB3aXRob3V0IGFsbG93aW5nIG1hbGZvcm1lZCBzZXR0aW5ncyB0byBkaXNhYmxlXG4gKiBzYWZldHkgZGVmYXVsdHMuIEludmFsaWQvbWlzc2luZyB0aW1lcyB1c2UgdGhlIGRvY3VtZW50ZWQgMDY6MDAgZGVmYXVsdDtcbiAqIHZhbGlkIHZhbHVlcyBhcmUgZGVkdXBsaWNhdGVkLCBzb3J0ZWQsIGFuZCBjYXBwZWQgYXQgdGhlIEFQSSBtYXhpbXVtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplRGFpbHlUaW1lcyh2YWx1ZTogdW5rbm93bik6IHN0cmluZ1tdIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIFsuLi5ERUZBVUxUX0RBSUxZX1RJTUVTXTtcbiAgY29uc3QgdGltZXMgPSBbXG4gICAgLi4ubmV3IFNldCh2YWx1ZS5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIHN0cmluZyA9PiBpc0RhaWx5VGltZShpdGVtKSkpLFxuICBdLnNvcnQoKTtcbiAgcmV0dXJuIHRpbWVzLmxlbmd0aCA+IDBcbiAgICA/IHRpbWVzLnNsaWNlKDAsIE1BWF9EQUlMWV9USU1FUylcbiAgICA6IFsuLi5ERUZBVUxUX0RBSUxZX1RJTUVTXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUF1dG9QcmludENvbmZpZyhyYXc6IHVua25vd24pOiBBdXRvUHJpbnRDb25maWcge1xuICBjb25zdCB2ID0gKHJhdyA/PyB7fSkgYXMgUGFydGlhbDxBdXRvUHJpbnRDb25maWc+O1xuICBjb25zdCBkID0gREVGQVVMVF9BVVRPX1BSSU5UX0NPTkZJRztcbiAgcmV0dXJuIHtcbiAgICBlbmFibGVkOiB0eXBlb2Ygdi5lbmFibGVkID09PSBcImJvb2xlYW5cIiA/IHYuZW5hYmxlZCA6IGQuZW5hYmxlZCxcbiAgICBzY2hlZHVsZU1vZGU6IGlzQXV0b1ByaW50U2NoZWR1bGVNb2RlKHYuc2NoZWR1bGVNb2RlKVxuICAgICAgPyB2LnNjaGVkdWxlTW9kZVxuICAgICAgOiBkLnNjaGVkdWxlTW9kZSxcbiAgICBzY2hlZHVsZUhvdXJzOlxuICAgICAgdHlwZW9mIHYuc2NoZWR1bGVIb3VycyA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgTnVtYmVyLmlzSW50ZWdlcih2LnNjaGVkdWxlSG91cnMpICYmXG4gICAgICB2LnNjaGVkdWxlSG91cnMgPj0gMSAmJlxuICAgICAgdi5zY2hlZHVsZUhvdXJzIDw9IDI0XG4gICAgICAgID8gdi5zY2hlZHVsZUhvdXJzXG4gICAgICAgIDogZC5zY2hlZHVsZUhvdXJzLFxuICAgIGRhaWx5VGltZXM6IG5vcm1hbGl6ZURhaWx5VGltZXModi5kYWlseVRpbWVzKSxcbiAgICBzb3VyY2VTdGF0dXNJZHM6IEFycmF5LmlzQXJyYXkodi5zb3VyY2VTdGF0dXNJZHMpXG4gICAgICA/IHYuc291cmNlU3RhdHVzSWRzLmZpbHRlcigocyk6IHMgaXMgc3RyaW5nID0+IHR5cGVvZiBzID09PSBcInN0cmluZ1wiKVxuICAgICAgOiBkLnNvdXJjZVN0YXR1c0lkcyxcbiAgICBlcnJvclN0YXR1c0lkOiB0eXBlb2Ygdi5lcnJvclN0YXR1c0lkID09PSBcInN0cmluZ1wiID8gdi5lcnJvclN0YXR1c0lkIDogbnVsbCxcbiAgICBlcnJvclN0YXR1c05hbWU6XG4gICAgICB0eXBlb2Ygdi5lcnJvclN0YXR1c05hbWUgPT09IFwic3RyaW5nXCIgPyB2LmVycm9yU3RhdHVzTmFtZSA6IG51bGwsXG4gICAgcHJpbnRlcklkOiB0eXBlb2Ygdi5wcmludGVySWQgPT09IFwic3RyaW5nXCIgPyB2LnByaW50ZXJJZCA6IG51bGwsXG4gICAgcHJpbnRlck5hbWU6IHR5cGVvZiB2LnByaW50ZXJOYW1lID09PSBcInN0cmluZ1wiID8gdi5wcmludGVyTmFtZSA6IG51bGwsXG4gICAgY29waWVzOlxuICAgICAgdHlwZW9mIHYuY29waWVzID09PSBcIm51bWJlclwiICYmXG4gICAgICBOdW1iZXIuaXNJbnRlZ2VyKHYuY29waWVzKSAmJlxuICAgICAgdi5jb3BpZXMgPj0gMSAmJlxuICAgICAgdi5jb3BpZXMgPD0gMTBcbiAgICAgICAgPyB2LmNvcGllc1xuICAgICAgICA6IGQuY29waWVzLFxuICAgIGRyeVJ1bjogdHlwZW9mIHYuZHJ5UnVuID09PSBcImJvb2xlYW5cIiA/IHYuZHJ5UnVuIDogZC5kcnlSdW4sXG4gICAgZXhjbHVkZUF0dGFjaG1lbnRzOlxuICAgICAgdHlwZW9mIHYuZXhjbHVkZUF0dGFjaG1lbnRzID09PSBcImJvb2xlYW5cIlxuICAgICAgICA/IHYuZXhjbHVkZUF0dGFjaG1lbnRzXG4gICAgICAgIDogZC5leGNsdWRlQXR0YWNobWVudHMsXG4gICAgY2F0ZWdvcnlNYXBwaW5nczogQXJyYXkuaXNBcnJheSh2LmNhdGVnb3J5TWFwcGluZ3MpXG4gICAgICA/IHYuY2F0ZWdvcnlNYXBwaW5ncy5maWx0ZXIoXG4gICAgICAgICAgKG0pOiBtIGlzIENhdGVnb3J5TWFwcGluZyA9PlxuICAgICAgICAgICAgISFtICYmXG4gICAgICAgICAgICB0eXBlb2YgbS5jYXRlZ29yeSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAgICAgbS5jYXRlZ29yeS5sZW5ndGggPiAwICYmXG4gICAgICAgICAgICB0eXBlb2YgbS5zdGF0dXNJZCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAgICAgdHlwZW9mIG0uc3RhdHVzTmFtZSA9PT0gXCJzdHJpbmdcIixcbiAgICAgICAgKVxuICAgICAgOiBkLmNhdGVnb3J5TWFwcGluZ3MsXG4gICAgcm91dGluZ01vZGU6IHYucm91dGluZ01vZGUgPT09IFwiY29uZGl0aW9uYWxcIiA/IFwiY29uZGl0aW9uYWxcIiA6IFwic2ltcGxlXCIsXG4gICAgcm91dGluZ1J1bGVzOiBBcnJheS5pc0FycmF5KHYucm91dGluZ1J1bGVzKVxuICAgICAgPyB2LnJvdXRpbmdSdWxlcy5maWx0ZXIoaXNWYWxpZEF1dG9QcmludFJvdXRpbmdSdWxlKS5tYXAoKHJ1bGUpID0+ICh7XG4gICAgICAgICAgLi4ucnVsZSxcbiAgICAgICAgICBuaWNrbmFtZUtleXdvcmRzOiBydWxlLm5pY2tuYW1lS2V5d29yZHNcbiAgICAgICAgICAgID8gWy4uLm5ldyBNYXAocnVsZS5uaWNrbmFtZUtleXdvcmRzLm1hcCgod29yZCkgPT4gW3dvcmQudHJpbSgpLnRvTG93ZXJDYXNlKCksIHdvcmQudHJpbSgpXSkpLnZhbHVlcygpXVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICB9KSlcbiAgICAgIDogW10sXG4gIH07XG59Il0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sWUFBWTtBQUNuQixPQUFPLFVBQVU7OztBQzZCakIsSUFBTSx5QkFBOEQ7QUFBQSxFQUNsRSxtQkFBbUI7QUFBQSxFQUNuQix5QkFBeUI7QUFBQSxFQUN6Qiw0Q0FBNEM7QUFBQSxFQUM1QyxZQUFZO0FBQUEsRUFDWixpQ0FBaUM7QUFBQSxFQUNqQyxrQ0FBa0M7QUFDcEM7QUFFQSxJQUFNLG1CQUF3RDtBQUFBLEVBQzVELGdCQUFnQjtBQUFBLEVBQ2hCLGdCQUFnQjtBQUFBLEVBQ2hCLGlCQUFpQjtBQUFBLEVBQ2pCLFlBQVk7QUFBQSxFQUNaLGVBQWU7QUFBQSxFQUNmLElBQUk7QUFBQSxFQUNKLHdCQUF3QjtBQUFBLEVBQ3hCLDJDQUEyQztBQUFBLEVBQzNDLGdCQUFnQjtBQUFBLEVBQ2hCLGNBQWM7QUFBQSxFQUNkLEtBQUs7QUFBQSxFQUNMLGdDQUFnQztBQUFBLEVBQ2hDLGlDQUFpQztBQUFBLEVBQ2pDLHVCQUF1QjtBQUFBLEVBQ3ZCLDJCQUEyQjtBQUFBLEVBQzNCLEtBQUs7QUFDUDtBQUVBLElBQU0seUJBQXlCLG9CQUFJLElBQUk7QUFBQSxFQUNyQztBQUFBLEVBQ0E7QUFDRixDQUFDO0FBd0JNLFNBQVMsNEJBQTRCLE1BQXlDO0FBQ25G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
