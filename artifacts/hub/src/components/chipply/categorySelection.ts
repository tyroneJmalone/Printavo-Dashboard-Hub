import type { ChipplyCategorySelection } from "@workspace/api-client-react";

export type CategorySelection = ChipplyCategorySelection;

export function selectionKey(selection: CategorySelection) {
  return JSON.stringify([selection.orderId, selection.lineItemId]);
}

export function selectionCounts(selections: CategorySelection[]) {
  return { invoices: new Set(selections.map((s) => s.orderId)).size, lines: selections.length };
}

export function toggleSelection(previous: CategorySelection[], selection: CategorySelection, checked: boolean, cap: number) {
  const rest = previous.filter((s) => selectionKey(s) !== selectionKey(selection));
  if (!checked) return rest;
  if (rest.length >= cap) return previous;
  return [...rest, selection];
}