import { ruleMatches, type RuleOrderComposition } from "../../purchasing/ruleMatching";
import type { DecorationClassification } from "../../purchasing/decorationClassifier";
import type { AutoPrintRoutingRule } from "./configValidation";
import { nicknameMethods } from "./decorationEvidence";

export interface AutoPrintRoutingCandidate {
  classification: DecorationClassification;
  businessDaysOut: number | null;
  nickname: string | null;
  sourceStatusId?: string | null;
}

export function successfulPostPrintCandidates<T>(
  outcomes: { candidate: T; outcome: "printed" | "failed" | "dry_run" }[],
): T[] {
  return outcomes
    .filter((item) => item.outcome === "printed")
    .map((item) => item.candidate);
}

/** Pure first-match evaluator. Rules are already stored in priority order. */
export function conditionalAutoPrintDestination(
  rules: AutoPrintRoutingRule[],
  candidate: AutoPrintRoutingCandidate,
): AutoPrintRoutingRule | null {
  const comp: RuleOrderComposition = {
    groups: candidate.classification.groups,
    mixed: candidate.classification.mixed,
  };
  return (
    rules.find((rule) => {
      if (!rule.enabled) return false;
      if (rule.sourceStatusIds?.length && !rule.sourceStatusIds.includes(candidate.sourceStatusId ?? "")) return false;
      const methods = new Set([...candidate.classification.groups, ...nicknameMethods(candidate.nickname)]);
      if (rule.requiredMethods?.some(method => !methods.has(method))) return false;
      const ruleComp = rule.requiredMethods?.length
        ? { groups: methods, mixed: comp.mixed || methods.size > 1 }
        : comp;
      return ruleMatches(
        {
          specialMixedDeco: rule.decoration === "mixed",
          decoGroup:
            rule.decoration === "any" || rule.decoration === "mixed"
              ? null
              : rule.decoration,
          dueComparator: rule.dueComparator,
          dueBusinessDays: rule.dueBusinessDays,
          nicknameKeywords: rule.nicknameKeywords,
        },
        ruleComp,
        candidate.businessDaysOut,
        candidate.nickname,
      );
    }) ?? null
  );
}