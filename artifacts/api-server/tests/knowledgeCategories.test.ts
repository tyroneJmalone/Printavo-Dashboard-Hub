import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillKnowledgeTopicCategories,
  defaultKnowledgeGroupForCategory,
  KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT,
  KNOWLEDGE_TOPIC_CATEGORIES,
  needsCategoryBackfill,
  validateKnowledgeClassificationSettings,
  versionedCategorySettings,
} from "../src/lib/knowledgeClassification";
import { shouldDemoteApprovedEntry } from "../src/lib/knowledgeEditorial";
import { candidateExtractionPrompt, DraftCandidateSchema } from "../src/lib/knowledgeToneRecovery";

const legacy = KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT.groups.map((group) => ({
  ...group,
  rules: group.id === "internal_operational" ? ["Custom staff guidance"] : [...group.rules],
  categories: group.id === "internal_operational"
    ? ["general", "policy", "pricing", "production", "shipping", "faq", "Custom topic"]
    : group.id === "customer_shareable"
      ? ["Approved custom topic", "Sales Resources & FAQs"]
      : [],
}));

test("new defaults include all five topic categories, internally by default", () => {
  const defaults = KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT;
  for (const category of KNOWLEDGE_TOPIC_CATEGORIES) {
    assert.ok(defaults.groups.find((group) => group.id === "internal_operational")!.categories.includes(category));
    assert.equal(defaultKnowledgeGroupForCategory(category, defaults), "internal_operational");
  }
  assert.equal(defaults.groups.find((group) => group.id === "internal_operational")!.categories.length, 11);
});

test("legacy settings get an additive one-time backfill without changing custom mappings or rules", () => {
  assert.equal(needsCategoryBackfill({ groups: legacy }), true);
  const initialValue = versionedCategorySettings(legacy, { groups: legacy });
  const merged = initialValue.groups;
  assert.deepEqual(merged.find((group) => group.id === "customer_shareable")!.categories,
    ["Approved custom topic", "Sales Resources & FAQs"]);
  assert.deepEqual(merged.find((group) => group.id === "internal_operational")!.rules, ["Custom staff guidance"]);
  assert.ok(merged.find((group) => group.id === "internal_operational")!.categories.includes("Custom topic"));
  assert.equal(defaultKnowledgeGroupForCategory("Sales Resources & FAQs", { groups: merged, updatedAt: null }),
    "customer_shareable");
  assert.equal(merged.find((group) => group.id === "internal_operational")!.categories.length, 11);
  validateKnowledgeClassificationSettings({ groups: merged, updatedAt: null });
  // Once saved, the version marker suppresses later backfills, even if an admin removed a topic.
  const adminEdited = merged.map((group) => ({
    ...group,
    categories: group.categories.filter((category) => category !== "Training & SOPs"),
  }));
  const adminSaved = versionedCategorySettings(adminEdited, initialValue);
  assert.equal(needsCategoryBackfill(adminSaved), false);
  assert.deepEqual(versionedCategorySettings(adminSaved.groups, adminSaved).groups, adminEdited);
  assert.ok(!adminSaved.groups.find((group) => group.id === "internal_operational")!
    .categories.includes("Training & SOPs"));
  assert.equal(defaultKnowledgeGroupForCategory("Training & SOPs", { groups: adminEdited, updatedAt: null }),
    "internal_operational");
});

test("category defaults do not override explicit usage or approval boundaries", () => {
  const mapped = backfillKnowledgeTopicCategories(legacy);
  assert.equal(defaultKnowledgeGroupForCategory("Sales Resources & FAQs", { groups: mapped, updatedAt: null }),
    "customer_shareable");
  const explicitGroup = "internal_operational";
  assert.equal(explicitGroup, "internal_operational");
  const fields = {
    title: "Staff notes", body: "Internal pricing detail", category: "Sales Resources & FAQs",
    tags: [], effectiveDate: null, expiresDate: null, knowledgeGroup: explicitGroup,
  };
  assert.equal(shouldDemoteApprovedEntry("approved", fields, { knowledgeGroup: "customer_shareable" }), true);
  assert.equal(shouldDemoteApprovedEntry("draft", fields, { knowledgeGroup: "customer_shareable" }), false);
});

test("semantic import accepts new topics while leaving tone and approval separate", () => {
  const prompt = candidateExtractionPrompt(false);
  const draft = {
    sourceIndexes: [0], title: "Staff handbook", body: "Staff-only procedures",
    tags: [], effectiveDate: null, expiresDate: null, candidateType: "fact",
  };
  for (const category of KNOWLEDGE_TOPIC_CATEGORIES) {
    assert.ok(prompt.includes(category));
    assert.equal(DraftCandidateSchema.parse({ ...draft, category }).category, category);
  }
  assert.match(prompt, /human-reviewed drafts/);
  assert.match(prompt, /Do not choose a knowledge group/);
  assert.equal(DraftCandidateSchema.parse({ ...draft, category: "general" }).category, "general");
});