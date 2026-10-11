import assert from "node:assert/strict";
import test from "node:test";
import { classifyAutoPrint, nicknameMethods, planMerchCategories } from "../src/lib/printQueue/autoPrint/decorationEvidence";
import { conditionalAutoPrintDestination } from "../src/lib/printQueue/autoPrint/routing";
import { normalizeAutoPrintConfig, isValidAutoPrintRoutingRule, type AutoPrintRoutingRule } from "../src/lib/printQueue/autoPrint/configValidation";
import { coverDate, coverSheetScript } from "../src/lib/printQueue/autoPrint/coverSheet";
import type { PvOrderDetailNode } from "@workspace/printavo";
const group = (id: string, methods: string[], category: string | null = null, qty = 6, item = "TEE") => ({
  id, position: 1, lineItems: { pageInfo: { hasNextPage: false }, nodes: [
    { id: `${id}-line`, items: qty, itemNumber: item, category: category ? { id: category, name: category } : null },
  ] }, imprints: { pageInfo: { hasNextPage: false }, nodes: methods.map(name => ({
    id: name, typeOfWork: null, pricingMatrixColumn: { matrix: { name } },
  })) },
});
const node = (...groups: ReturnType<typeof group>[]) => ({ lineItemGroups: { nodes: groups, pageInfo: { hasNextPage: false } } }) as unknown as PvOrderDetailNode;
const rule: AutoPrintRoutingRule = { id: "mixed", enabled: true, decoration: "mixed", dueComparator: null, dueBusinessDays: null, nicknameKeywords: null, statusId: "waiting", statusName: "MERCH MIXED Waiting", sourceStatusIds: ["ordered"], requiredMethods: ["embroidery", "heat"], merchCategoryAction: "all_lines" };
test("controlled nickname tokens identify methods, not arbitrary words", () => {
  assert.deepEqual(nicknameMethods("PRINT: front / PRINT: back / EMB: chest"), ["print", "embroidery"]);
  assert.deepEqual(nicknameMethods("heat wave rush imprint embroidery"), []);
});
test("source status and ALL required methods match; existing Any Status rules still work", () => {
  const candidate = { classification: classifyAutoPrint(node(group("a", []))), nickname: "601541 EMB: LC HEAT: sleeve", businessDaysOut: null, sourceStatusId: "ordered" };
  assert.equal(conditionalAutoPrintDestination([rule], candidate)?.id, "mixed");
  assert.equal(conditionalAutoPrintDestination([rule], { ...candidate, sourceStatusId: "complete" }), null);
  assert.equal(conditionalAutoPrintDestination([rule], { ...candidate, nickname: "EMB: LC" }), null);
  assert.equal(conditionalAutoPrintDestination([{ ...rule, sourceStatusIds: [], requiredMethods: [], decoration: "any" }], candidate)?.id, "mixed");
});
test("classifies mixed group and distinct groups; preserves explicit Mixed category", () => {
  for (const detail of [node(group("a", ["Embroidery", "Heat Applied Graphics"])), node(group("a", ["Embroidery"]), group("b", ["1st PRINT LOC -2025"])), node(group("a", ["Screen Printing"], "Mixed Decoration"))]) {
    assert.equal(classifyAutoPrint(detail).mixed, true);
  }
});
test("sparse MERCH requires explicit scope and leaves existing categories intact", () => {
  const detail = node(group("a", []), group("b", [], "Embroidery"));
  assert.deepEqual(planMerchCategories(detail, rule, "601541 EMB: LC HEAT: sleeve", "MERCH - Ordered"), [{ lineItemId: "a-line", categoryName: "Mixed Decoration" }]);
  assert.throws(() => planMerchCategories(detail, { ...rule, merchCategoryAction: "evidence" }, "601541 EMB: LC", "MERCH Ordered"), /No decoration evidence/);
  assert.throws(() => planMerchCategories(detail, rule, "Regular invoice", "Ordered"), /recognized MERCH/);
});
test("subset personalization remains separate; no quantity or existing category changes", () => {
  const detail = node(group("shirts", ["Screen Printing"], "Mixed Decoration", 81), group("names", ["Heat Press"], null, 69, ""));
  const before = JSON.stringify(detail);
  assert.deepEqual(planMerchCategories(detail, { ...rule, merchCategoryAction: "evidence" }, "601541 PRINT: front", "MERCH MIXED"), [{ lineItemId: "names-line", categoryName: "HEAT APPLIED GRAPHICS" }]);
  assert.equal(JSON.stringify(detail), before);
});
test("incomplete evidence fails closed; unrecognized personalization is not guessed as Heat", () => {
  const detail = node(group("a", ["Personalization"]));
  assert.throws(() => planMerchCategories(detail, { ...rule, merchCategoryAction: "evidence" }, "601541 EMB: LC", "MERCH Ordered"));
  detail.lineItemGroups.nodes[0].imprints.pageInfo.hasNextPage = true;
  assert.throws(() => planMerchCategories(detail, rule, "601541 EMB: LC", "MERCH Ordered"), /Incomplete/);
});
test("settings persist controls and reject invalid or unscoped assignment", () => {
  assert.equal(isValidAutoPrintRoutingRule(rule), true);
  assert.equal(isValidAutoPrintRoutingRule({ ...rule, requiredMethods: [] }), false);
  assert.equal(isValidAutoPrintRoutingRule({ ...rule, sourceStatusIds: [123] }), false);
  const saved = normalizeAutoPrintConfig(JSON.parse(JSON.stringify({ coverSheet: false, routingRules: [rule] })));
  assert.equal(saved.coverSheet, false);
  assert.deepEqual(saved.routingRules[0], rule);
});
test("cover dates use UTC and labels remain literal text", () => {
  assert.equal(coverDate("2026-10-12T00:00:00Z"), "10/12/2026");
  assert.equal(coverDate(null), "Not recorded");
  const script = coverSheetScript({ visualId: 123, nickname: "<script>rush</script>" }, true);
  assert.ok(script.includes("textContent"));
  assert.ok(script.includes("Rush/Firm Deadline"));
  assert.ok(script.includes("UPDATED"));
});
