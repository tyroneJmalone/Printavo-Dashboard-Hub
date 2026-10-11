import type { PvOrderDetailNode } from "@workspace/printavo";
import { classifyDecorationLines, type DecorationClassification } from "../../purchasing/decorationClassifier";
import type { AutoPrintRoutingRule } from "./configValidation";

export type Method = "print" | "embroidery" | "heat";
export function nicknameMethods(nickname: string | null | undefined): Method[] {
  const found = new Set<Method>();
  for (const match of (nickname ?? "").matchAll(/\b(PRINT|EMB|HEAT)\s*:/gi)) {
    found.add(({ PRINT: "print", EMB: "embroidery", HEAT: "heat" } as const)[match[1].toUpperCase() as "PRINT" | "EMB" | "HEAT"]);
  }
  return [...found];
}
export function groupMethods(group: PvOrderDetailNode["lineItemGroups"]["nodes"][number]): Method[] {
  const found = new Set<Method>();
  for (const imprint of group.imprints.nodes) {
    const text = `${imprint.typeOfWork?.name ?? ""} ${imprint.pricingMatrixColumn?.matrix?.name ?? ""}`;
    if (/\b(screen\s*print(?:ing)?|print\s+loc|printing)\b/i.test(text)) found.add("print");
    if (/\b(embroidery|embroider|emb)\b/i.test(text)) found.add("embroidery");
    if (/\b(heat|dtf|vinyl)\b/i.test(text)) found.add("heat");
  }
  return [...found];
}
export function classifyAutoPrint(node: PvOrderDetailNode): DecorationClassification {
  const lines = node.lineItemGroups.nodes.flatMap(g => g.lineItems.nodes);
  const classification = classifyDecorationLines(lines.map(l => ({ categoryName: l.category?.name ?? null, items: l.items })), { positiveQuantityOnly: true });
  for (const group of node.lineItemGroups.nodes) {
    if (group.imprints && !group.imprints.pageInfo.hasNextPage && group.lineItems.nodes.some(l => l.items > 0)) {
      for (const method of groupMethods(group)) classification.groups.add(method);
    }
  }
  classification.mixed ||= classification.groups.size > 1;
  classification.kind = classification.mixed ? "mixed" : [...classification.groups][0] ?? null;
  return classification;
}
export type CategoryAssignment = { lineItemId: string; categoryName: string };
export function planMerchCategories(node: PvOrderDetailNode, rule: AutoPrintRoutingRule | null, nickname: string | null, statusName: string | null): CategoryAssignment[] {
  if (!rule?.merchCategoryAction || rule.merchCategoryAction === "none") return [];
  if (!/\bMERCH\b/i.test(statusName ?? "") || !/^\d{5,7}\s/.test(nickname ?? "")) throw new Error("Category assignment requires a recognized MERCH invoice");
  const assignments: CategoryAssignment[] = [];
  for (const group of node.lineItemGroups.nodes) {
    if (group.imprints.pageInfo.hasNextPage || group.lineItems.pageInfo.hasNextPage) throw new Error("Incomplete group evidence; category review required");
    for (const line of group.lineItems.nodes) {
      if (line.category || line.items <= 0) continue;
      // All-lines is an explicit operator assertion, limited to actual merchandise.
      const methods = rule.merchCategoryAction === "all_lines" && line.itemNumber
        ? rule.requiredMethods ?? [] : groupMethods(group);
      if (!(rule.merchCategoryAction === "all_lines" && line.itemNumber) &&
        group.imprints.nodes.some(imprint => !groupMethods({ ...group, imprints: { ...group.imprints, nodes: [imprint] } }).length)) {
        throw new Error(`Incomplete imprint method evidence for line ${line.id}; category review required`);
      }
      if (!methods.length) throw new Error(`No decoration evidence for line ${line.id}; assign its category or configure an explicit all-lines rule`);
      const categoryName = methods.length > 1 ? "Mixed Decoration" : ({ print: "Screen Printing", embroidery: "Embroidery", heat: "HEAT APPLIED GRAPHICS" } as const)[methods[0]];
      assignments.push({ lineItemId: line.id, categoryName });
    }
  }
  return assignments;
}
