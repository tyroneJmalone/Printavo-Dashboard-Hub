const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Formats dashboard dates. Calendar strings (YYYY-MM-DD) are already Eastern
 * calendar days, so they are formatted in UTC to avoid shifting a day.
 * Real instants are converted to America/New_York.
 */
export function formatDashboardDate(value: string, opts: Intl.DateTimeFormatOptions): string {
  const dateOnly = DATE_ONLY.test(value);
  const d = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: dateOnly ? "UTC" : "America/New_York",
    ...opts,
  }).format(d);
}
