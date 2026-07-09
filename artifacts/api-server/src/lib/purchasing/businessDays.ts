/**
 * Business-day math for the status rules engine (P3d).
 *
 * Business days = Mon–Fri minus the shop's holiday list (Tyler, 2026-07-09):
 * July 4, Memorial Day (last Mon of May), Labor Day (1st Mon of Sep),
 * Thanksgiving (4th Thu of Nov) + Thanksgiving Eve, Christmas Eve, Christmas,
 * New Year's Eve, New Year's Day.
 *
 * Printavo stores customer due dates as date-only values (verified: every
 * pv_orders.customer_due_at is exactly UTC midnight), so due dates are read
 * as UTC calendar dates. The PO date (push completion) is a real instant and
 * is converted to the shop's local calendar day first.
 */

/** Shop-local timezone used to turn the push instant into a calendar day. */
export const SHOP_TIMEZONE = "America/New_York";

const pad = (n: number): string => String(n).padStart(2, "0");
const key = (y: number, m0: number, d: number): string =>
  `${y}-${pad(m0 + 1)}-${pad(d)}`;

/** Day of month of the nth <weekday> (0=Sun..6=Sat) of a month (m0 0-based). */
function nthWeekday(year: number, m0: number, weekday: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, m0, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
}

/** Day of month of the last <weekday> of a month. */
function lastWeekday(year: number, m0: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, m0 + 1, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, m0, lastDay)).getUTCDay();
  return lastDay - ((lastDow - weekday + 7) % 7);
}

const holidayCache = new Map<number, Set<string>>();

/** Shop holidays for a calendar year as YYYY-MM-DD keys. */
export function shopHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const s = new Set<string>();
  s.add(key(year, 0, 1)); // New Year's Day
  s.add(key(year, 4, lastWeekday(year, 4, 1))); // Memorial Day
  s.add(key(year, 6, 4)); // July 4
  s.add(key(year, 8, nthWeekday(year, 8, 1, 1))); // Labor Day
  const thanksgiving = nthWeekday(year, 10, 4, 4); // 4th Thu Nov (>= 22nd)
  s.add(key(year, 10, thanksgiving - 1)); // Thanksgiving Eve
  s.add(key(year, 10, thanksgiving)); // Thanksgiving
  s.add(key(year, 11, 24)); // Christmas Eve
  s.add(key(year, 11, 25)); // Christmas
  s.add(key(year, 11, 31)); // New Year's Eve
  holidayCache.set(year, s);
  return s;
}

/** YYYY-MM-DD of an instant in the given IANA timezone. */
export function dateKeyInTimezone(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function parseKey(k: string): Date {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Business days from `fromKey` (exclusive) through `toKey` (inclusive),
 * both YYYY-MM-DD. Returns 0 when `toKey` is on or before `fromKey`
 * ("due today or overdue" — matches any `at_most` rule).
 */
export function businessDaysBetween(fromKey: string, toKey: string): number {
  const from = parseKey(fromKey);
  const to = parseKey(toKey);
  if (to.getTime() <= from.getTime()) return 0;
  let count = 0;
  const cur = new Date(from.getTime());
  while (true) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (cur.getTime() > to.getTime()) break;
    const dow = cur.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const k = key(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate());
    if (shopHolidays(cur.getUTCFullYear()).has(k)) continue;
    count += 1;
  }
  return count;
}

/**
 * Business days between a push instant and a Printavo date-only due date
 * (stored as UTC midnight).
 */
export function businessDaysUntilDue(poDate: Date, dueDate: Date): number {
  const fromKey = dateKeyInTimezone(poDate, SHOP_TIMEZONE);
  const toKey = dueDate.toISOString().slice(0, 10);
  return businessDaysBetween(fromKey, toKey);
}
