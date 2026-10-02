export interface StoreFilterFields {
  storeName: string;
  eventId: string | null;
  closedAt: string | null;
  pvCustomerCompany: string | null;
  organizationName?: string | null;
}

export interface StoreFilters {
  query: string;
  closedFrom: string; // YYYY-MM-DD or ""
  closedTo: string; // YYYY-MM-DD or ""
}

export const EMPTY_STORE_FILTERS: StoreFilters = { query: "", closedFrom: "", closedTo: "" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Date-only YYYY-MM-DD prefix, or null. Compared as strings — no timezone math. */
export function dateOnly(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

export function isFilterActive(f: StoreFilters): boolean {
  return !!(f.query.trim() || dateOnly(f.closedFrom) || dateOnly(f.closedTo));
}

export function isDateFilterActive(f: StoreFilters): boolean {
  return !!(dateOnly(f.closedFrom) || dateOnly(f.closedTo));
}

export function matchesText(
  query: string,
  fields: Array<string | null | undefined>,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const terms = q.split(/\s+/);
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function matchesStore(s: StoreFilterFields, f: StoreFilters): boolean {
  if (
    !matchesText(f.query, [s.storeName, s.pvCustomerCompany, s.organizationName, s.eventId])
  )
    return false;
  let from = dateOnly(f.closedFrom);
  let to = dateOnly(f.closedTo);
  if (from && to && from > to) [from, to] = [to, from];
  if (from || to) {
    const d = dateOnly(s.closedAt);
    if (!d) return false; // undated excluded only while a date bound is active
    if (from && d < from) return false;
    if (to && d > to) return false; // inclusive
  }
  return true;
}

export function filterStores<T>(
  rows: T[],
  f: StoreFilters,
  pick: (row: T) => StoreFilterFields,
): T[] {
  if (!isFilterActive(f)) return rows;
  return rows.filter((r) => matchesStore(pick(r), f));
}
