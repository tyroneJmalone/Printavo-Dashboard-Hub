export const SUMMARY_RECIPIENT = "it@mintprintworks.com";
export const SUMMARY_SCHEDULE = "Daily at 8:00 AM and 2:00 PM America/New_York";
const eastern = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});
function parts(date: Date) {
  return Object.fromEntries(eastern.formatToParts(date).map(p => [p.type, p.value]));
}
function dayBefore(day: string) {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function slotAt(day: string, hour: number) {
  for (const offset of [4, 5]) {
    const date = new Date(`${day}T${String(hour + offset).padStart(2, "0")}:00:00Z`);
    const p = parts(date);
    if (`${p.year}-${p.month}-${p.day}` === day && Number(p.hour) === hour) return date;
  }
  throw new Error("Could not resolve Eastern summary slot");
}
export function summaryEmailSlot(now: Date) {
  const p = parts(now);
  let day = `${p.year}-${p.month}-${p.day}`;
  let hour = Number(p.hour) >= 14 ? 14 : 8;
  if (Number(p.hour) < 8) { day = dayBefore(day); hour = 14; }
  const end = slotAt(day, hour);
  const start = hour === 14 ? slotAt(day, 8) : slotAt(dayBefore(day), 14);
  return { key: `${day}:${String(hour).padStart(2, "0")}`, start, end };
}
export function summarySlotDue(now: Date, activatedAt: Date) {
  const slot = summaryEmailSlot(now);
  const age = now.getTime() - slot.end.getTime();
  return activatedAt <= slot.end && age >= 0 && age < 15 * 60_000 ? slot : null;
}
