export function reconcileSuggestionSelection(
  selectedIds: ReadonlySet<string>,
  previousVisibleIds: readonly string[],
  visibleIds: readonly string[],
): Set<string> {
  const previous = new Set(previousVisibleIds);
  return new Set(
    visibleIds.filter((id) => selectedIds.has(id) || !previous.has(id)),
  );
}

export function selectedSuggestionIds(
  visibleIds: readonly string[],
  selectedIds: ReadonlySet<string>,
): string[] {
  return visibleIds.filter((id) => selectedIds.has(id));
}

export interface SuggestionInFlightGuard {
  acquire(id: string): boolean;
  release(id: string): void;
  has(id: string): boolean;
}

/** Synchronous guard shared by row and batch actions. */
export function createSuggestionInFlightGuard(): SuggestionInFlightGuard {
  const ids = new Set<string>();
  return {
    acquire(id) {
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    },
    release(id) {
      ids.delete(id);
    },
    has(id) {
      return ids.has(id);
    },
  };
}