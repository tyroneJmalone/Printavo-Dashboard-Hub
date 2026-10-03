export const REPORT_DATE_PRESETS = [
  ["today", "Today", "Today"],
  ["yesterday", "Yesterday", "Yesterday"],
  ["wtd", "WTD", "Week to date"],
  ["lw", "LW", "Last week"],
  ["mtd", "MTD", "Month to date"],
  ["lm", "LM", "Last month"],
  ["qtd", "QTD", "Quarter to date"],
  ["lq", "LQ", "Last quarter"],
  ["ytd", "YTD", "Year to date"],
  ["ly", "LY", "Last year"],
] as const;
export type ReportDatePreset = typeof REPORT_DATE_PRESETS[number][0];

/** Eastern civil dates; UTC arithmetic avoids DST and browser-timezone shifts. */
export function reportDateRange(preset: ReportDatePreset, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
  const y = get("year"), m = get("month") - 1, d = get("day");
  const date = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day));
  const today = date(y, m, d);
  const monday = d - (today.getUTCDay() + 6) % 7;
  const quarter = Math.floor(m / 3) * 3;
  let start = today, end = today;
  switch (preset) {
    case "yesterday": start = end = date(y, m, d - 1); break;
    case "wtd": start = date(y, m, monday); break;
    case "lw": start = date(y, m, monday - 7); end = date(y, m, monday - 1); break;
    case "mtd": start = date(y, m, 1); break;
    case "lm": start = date(y, m - 1, 1); end = date(y, m, 0); break;
    case "qtd": start = date(y, quarter, 1); break;
    case "lq": start = date(y, quarter - 3, 1); end = date(y, quarter, 0); break;
    case "ytd": start = date(y, 0, 1); break;
    case "ly": start = date(y - 1, 0, 1); end = date(y - 1, 11, 31); break;
  }
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}