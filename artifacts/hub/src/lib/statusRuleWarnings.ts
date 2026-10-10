/** Conservative full-shadow detection, in the server's returned evaluation order.
 * Partial overlaps and coverage by multiple rules are deliberately not claimed.
 */
interface Rule {
  id: string;
  enabled: boolean;
  specialMixedDeco: boolean;
  decoGroup?: string | null;
  dueComparator?: string | null;
  dueBusinessDays?: number | null;
  nicknameKeywords?: unknown;
}

function keywords(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

function covers(earlier: Rule, later: Rule): boolean {
  // Mixed rules ignore decoGroup; ordinary group rules exclude mixed orders.
  if (earlier.specialMixedDeco) {
    if (!later.specialMixedDeco) return false;
  } else if (earlier.decoGroup) {
    if (later.specialMixedDeco || earlier.decoGroup !== later.decoGroup) return false;
  }
  if (earlier.dueComparator && earlier.dueBusinessDays != null) {
    if (later.dueComparator !== earlier.dueComparator || later.dueBusinessDays == null) return false;
    if (earlier.dueComparator === "more_than") {
      if (earlier.dueBusinessDays > later.dueBusinessDays) return false;
    } else if (earlier.dueComparator === "at_most") {
      if (earlier.dueBusinessDays < later.dueBusinessDays) return false;
    } else return false;
  }
  const first = keywords(earlier.nicknameKeywords);
  const second = keywords(later.nicknameKeywords);
  // Compare escaped literal phrases case-insensitively, without trimming:
  // the matcher preserves spaces inside each stored keyword.
  return first.length === 0 || (second.length > 0 && second.every((word) =>
    first.some((candidate) => candidate.toLowerCase() === word.toLowerCase()),
  ));
}

export function shadowedStatusRules<T extends Rule>(rules: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  rules.forEach((rule, index) => {
    if (!rule.enabled) return;
    const blocker = rules.slice(0, index).find((earlier) => earlier.enabled && covers(earlier, rule));
    if (blocker) result.set(rule.id, blocker);
  });
  return result;
}
