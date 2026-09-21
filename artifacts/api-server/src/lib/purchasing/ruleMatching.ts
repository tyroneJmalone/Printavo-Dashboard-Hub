import type { DecoGroup } from "./decorationClassifier";

export interface RuleOrderComposition {
  groups: Set<DecoGroup>;
  mixed: boolean;
}

export interface DecoDueRuleShape {
  specialMixedDeco: boolean;
  decoGroup: string | null;
  dueComparator: string | null;
  dueBusinessDays: number | null;
  nicknameKeywords?: unknown;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function nicknameHasKeyword(nickname: string | null, keywords: string[]): boolean {
  if (!nickname) return false;
  return keywords.some((kw) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(kw)}([^\\p{L}\\p{N}]|$)`, "iu").test(nickname),
  );
}

function ruleKeywords(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const words = raw.filter((word): word is string => typeof word === "string" && word.trim() !== "");
  return words.length ? words : null;
}

/** Shared pure matcher for Purchasing and successful-print routing. */
export function ruleMatches(
  rule: DecoDueRuleShape,
  comp: RuleOrderComposition,
  businessDaysOut: number | null,
  nickname: string | null = null,
): boolean {
  if (rule.specialMixedDeco) {
    if (!comp.mixed) return false;
  } else if (rule.decoGroup) {
    if (comp.mixed) return false;
    if (comp.groups.size !== 1 || !comp.groups.has(rule.decoGroup as DecoGroup)) return false;
  }
  if (rule.dueComparator && rule.dueBusinessDays != null) {
    if (businessDaysOut == null) return false;
    if (rule.dueComparator === "more_than" && businessDaysOut <= rule.dueBusinessDays) return false;
    if (rule.dueComparator === "at_most" && businessDaysOut > rule.dueBusinessDays) return false;
  }
  const keywords = ruleKeywords(rule.nicknameKeywords);
  return !keywords || nicknameHasKeyword(nickname, keywords);
}