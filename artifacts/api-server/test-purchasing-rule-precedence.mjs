// Offline only: neither entry point imports a database or Printavo client.
import { build } from "esbuild";
import assert from "node:assert/strict";

async function load(path) {
  const result = await build({
    entryPoints: [new URL(path, import.meta.url).pathname],
    bundle: true, write: false, platform: "node", format: "esm",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { ruleMatches } = await load("./src/lib/purchasing/ruleMatching.ts");
const { shadowedStatusRules } = await load("../hub/src/lib/statusRuleWarnings.ts");
const base = { enabled: true, specialMixedDeco: false, decoGroup: "print", dueComparator: null, dueBusinessDays: null, nicknameKeywords: null };
const mixed = { ...base, id: "mixed", specialMixedDeco: true, decoGroup: null };
const general = { ...base, id: "general" };
const urgent = { ...base, id: "urgent", nicknameKeywords: ["Deadline", "RUSH", "FIRM"] };
const embroidery = { ...base, id: "embroidery", decoGroup: "embroidery" };
const heat = { ...base, id: "heat", decoGroup: "heat" };
const before = [mixed, heat, general, embroidery, urgent];
const after = [mixed, heat, urgent, general, embroidery];
const print = { groups: new Set(["print"]), mixed: false };
const pick = (rules, composition, name, days = null) =>
  rules.find((r) => r.enabled && ruleMatches(r, composition, days, name))?.id;
for (const name of ["Deadline job", "RUSH job", "rush job", "(DEADLINE)", "firm job"]) {
  assert.equal(pick(before, print, name), "general");
  assert.equal(pick(after, print, name), "urgent");
}
for (const name of [null, "", "Ordinary job", "brush", "RUSHED", "confirmed"]) {
  assert.equal(pick(after, print, name), "general");
}
assert.equal(pick(after, { groups: new Set(["print", "embroidery"]), mixed: true }, "RUSH"), "mixed");
for (const group of ["embroidery", "heat"]) {
  assert.equal(pick(after, { groups: new Set([group]), mixed: false }, "RUSH"), group);
}
assert.equal(pick([mixed, { ...urgent, enabled: false }, general], print, "RUSH"), "general");
assert.equal(shadowedStatusRules(before).get("urgent")?.id, "general");
assert.equal(shadowedStatusRules(after).size, 0);
assert.equal(shadowedStatusRules([{ ...general, enabled: false }, urgent]).size, 0);
assert.equal(shadowedStatusRules([general, { ...urgent, enabled: false }]).size, 0);
const atMost = { ...urgent, dueComparator: "at_most", dueBusinessDays: 5 };
assert.equal(pick([atMost, general], print, "RUSH", 5), "urgent");
assert.equal(pick([atMost, general], print, "RUSH", 6), "general");
assert.equal(pick([atMost, general], print, "RUSH", null), "general");
assert.equal(shadowedStatusRules([atMost, general]).size, 0);
assert.equal(shadowedStatusRules([general, atMost]).get("urgent")?.id, "general");
for (const comparator of ["at_most", "more_than"]) {
  const broadDays = comparator === "at_most" ? 10 : 2;
  const broad = { ...general, dueComparator: comparator, dueBusinessDays: broadDays };
  const narrow = { ...atMost, dueComparator: comparator };
  assert.equal(shadowedStatusRules([broad, narrow]).get("urgent")?.id, "general");
  assert.equal(shadowedStatusRules([narrow, broad]).size, 0);
}
assert.equal(shadowedStatusRules([urgent, { ...urgent, id: "subset", nicknameKeywords: ["rush"] }]).get("subset")?.id, "urgent");
assert.equal(shadowedStatusRules([urgent, { ...urgent, id: "overlap", nicknameKeywords: ["RUSH", "OTHER"] }]).size, 0);
assert.equal(shadowedStatusRules([{ ...general, decoGroup: null }, mixed]).get("mixed")?.id, "general");
console.log("Purchasing precedence and shadow warnings passed (offline; no database or status mutations).");
