export interface ComparisonRange { start: string; end: string }
export interface ComparisonMetrics { orders: number; quantity: number; revenue: number }
export interface ComparisonRow extends ComparisonMetrics { label: string }

function civilDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose both start and end dates to compare.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Choose valid calendar dates.");
  }
  return date;
}

/** Civil-date comparison, not a 365-day subtraction (which drifts in leap years). */
export function previousYearRange(start: string, end: string): ComparisonRange {
  const from = civilDate(start), through = civilDate(end);
  if (from > through) throw new Error("The start date must be on or before the end date.");
  const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const shift = (date: Date, completeMonthEnd = false) => {
    const year = date.getUTCFullYear() - 1, month = date.getUTCMonth();
    const day = completeMonthEnd ? lastDay(year, month) : Math.min(date.getUTCDate(), lastDay(year, month));
    return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  };
  // Full calendar months/quarters/years include all of the prior-year final
  // month, even when February has a different number of days.
  const completeMonths = from.getUTCDate() === 1 &&
    through.getUTCDate() === lastDay(through.getUTCFullYear(), through.getUTCMonth());
  return { start: shift(from), end: shift(through, completeMonths) };
}

const DATE_FIELDS = [
  ["createdStart", "createdEnd"], ["invoiceStart", "invoiceEnd"],
  ["productionDueStart", "productionDueEnd"], ["dueStart", "dueEnd"],
] as const;

/** Preserve every non-date filter. Comparison is for Orders, not observed activity. */
export function previousYearFilters<T extends object>(params: T, basis: "created" | "invoice" | "productionDue" | "due", range: ComparisonRange): T {
  const result = { ...params } as Record<string, unknown>;
  for (const [start, end] of DATE_FIELDS) { delete result[start]; delete result[end]; }
  for (const key of ["limit", "offset", "activityOnly", "activityStart", "activityEnd", "activityOwner"]) delete result[key];
  result[`${basis}Start`] = range.start;
  result[`${basis}End`] = range.end;
  return result as T;
}

export function comparisonChange(current: number, previous: number) {
  return {
    difference: current - previous,
    percent: previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100,
  };
}

/** Union, not intersection: never silently discard a prior-only or new group. */
export function joinComparisonRows(current: ComparisonRow[], previous: ComparisonRow[]) {
  const before = new Map(previous.map(row => [row.label, row]));
  const now = new Map(current.map(row => [row.label, row]));
  return [...new Set([...now.keys(), ...before.keys()])].map(label => ({
    label,
    current: now.get(label) ?? { label, orders: 0, quantity: 0, revenue: 0 },
    previous: before.get(label) ?? { label, orders: 0, quantity: 0, revenue: 0 },
    presence: !before.has(label) ? "new" : !now.has(label) ? "previous-only" : "both",
  }));
}
