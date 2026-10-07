/** Resolve Eastern civil midnight without assuming every day is 24 hours. */
export function easternMidnight(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid calendar date");
  const target = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(target.valueOf()) || target.toISOString().slice(0, 10) !== day) throw new Error("Invalid calendar date");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let instant = target.valueOf();
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    instant += target.valueOf() - represented;
  }
  return new Date(instant);
}

export function easternCalendarRange(startDay: string, endDay: string) {
  const start = easternMidnight(startDay);
  easternMidnight(endDay); // validate before calendar arithmetic
  if (startDay > endDay) throw new Error("Start must not follow end");
  const next = new Date(`${endDay}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start, end: easternMidnight(next.toISOString().slice(0, 10)) };
}
