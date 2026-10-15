import { z } from "zod";

export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value && value >= "1900-01-01" && value <= "2200-12-31";
}
export const day = z.string().refine(validDate, "Use a real calendar date (YYYY-MM-DD)");
const id = z.string().min(1).max(100);
const text = z.string().max(6000);
const owner = z.string().trim().max(320).transform(v => v.toLowerCase());
const customerId = z.string().regex(/^\d+$/);
export const eventSchema = z.object({
  title: z.string().trim().min(1).max(200), startDate: day, endDate: day.nullable(),
  precision: z.enum(["day", "month"]), recurrence: z.enum(["once", "annual"]),
  leadDays: z.number().int().min(0).max(365), nicheIds: z.array(z.string().uuid()).max(100),
  customerIds: z.array(customerId).max(500), owner, notes: text, merchandise: text,
}).strict().refine(v => v.nicheIds.length + v.customerIds.length > 0, "Choose at least one niche or customer")
  .refine(v => v.precision !== "month" || (v.startDate.endsWith("-01") && (!v.endDate || v.endDate.endsWith("-01"))), "Month-based dates must use the first of the month")
  .refine(v => !v.endDate || (v.endDate >= v.startDate && Date.parse(v.endDate) - Date.parse(v.startDate) < 366 * 86400000), "End date must follow start within one year");
export const followupSchema = z.object({
  customerId, contactId: id.nullable().optional(), title: z.string().trim().min(1).max(200),
  dueDate: day, status: z.enum(["needs_contact", "contacted", "waiting", "opportunity", "snoozed", "dismissed", "completed"]),
  owner, notes: text, sourceType: z.enum(["manual", "event", "anniversary", "custom_field"]),
  sourceId: id.nullable(), occurrenceDate: day.nullable(), invoiceIds: z.array(id).max(500),
}).strict().refine(v => v.sourceType === "manual" || (v.sourceId !== null && v.occurrenceDate !== null),
  "Sourced follow-ups need a source and occurrence date");
export const fieldSchema = z.object({
  name: z.string().trim().min(1).max(100), scope: z.enum(["customer", "contact"]),
  type: z.enum(["text", "number", "date", "annual_date", "dropdown", "boolean"]),
  options: z.array(z.string().trim().min(1).max(200)).max(100),
  reminderEnabled: z.boolean(), leadDays: z.number().int().min(0).max(365),
}).strict().refine(v => !v.reminderEnabled || ["date", "annual_date"].includes(v.type), "Only date fields can create reminders")
  .refine(v => v.type !== "dropdown" || (v.options.length > 0 && new Set(v.options).size === v.options.length), "Dropdown needs unique options");
export const valueSchema = z.object({ fieldId: z.string().uuid(), customerId, contactId: id.nullable(), value: z.string().max(2000) }).strict();
export const overrideSchema = z.object({
  eventId: z.string().uuid(), customerId, occurrenceDate: day, excluded: z.boolean(), startDate: day.nullable(), notes: text,
}).strict();
export const schemas = { event: eventSchema, followup: followupSchema, field: fieldSchema, value: valueSchema, override: overrideSchema };
export type Kind = keyof typeof schemas;
export type Event = z.infer<typeof eventSchema>;
export type Followup = z.infer<typeof followupSchema>;
export type Field = z.infer<typeof fieldSchema>;
export type Value = z.infer<typeof valueSchema>;
export type Override = z.infer<typeof overrideSchema>;
export interface RecordRow { id: string; kind: Kind; customer_id: string | null; payload: any; version: number; archived: boolean }

export function validateValue(field: Field, value: Value): boolean {
  if ((field.scope === "contact") !== Boolean(value.contactId)) return false;
  if (value.value === "") return true;
  switch (field.type) {
    case "number": return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.value) && Number.isFinite(Number(value.value));
    case "date": return validDate(value.value);
    case "annual_date": return /^\d{2}-\d{2}$/.test(value.value) && validDate(`2000-${value.value}`);
    case "boolean": return ["true", "false"].includes(value.value);
    case "dropdown": return field.options.includes(value.value);
    default: return true;
  }
}
export function naturalKey(kind: Kind, data: any): string | null {
  if (kind === "field") return JSON.stringify([kind, data.scope, data.name.toLowerCase()]);
  if (kind === "value") return JSON.stringify([kind, data.fieldId, data.customerId, data.contactId]);
  if (kind === "override") return JSON.stringify([kind, data.eventId, data.customerId, data.occurrenceDate]);
  if (kind === "followup" && data.sourceType !== "manual")
    return JSON.stringify([kind, data.customerId, data.sourceType, data.sourceId, data.occurrenceDate]);
  return null;
}
export function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
}
/** Annual February 29 anniversaries use February 28 in non-leap years. */
export function inYear(date: string, year: number): string {
  const value = `${year}-${date.slice(5)}`;
  return validDate(value) ? value : `${year}-02-28`;
}
export function eventDates(event: Event, from: string, to: string) {
  const years = event.recurrence === "once" ? [Number(event.startDate.slice(0, 4))]
    : Array.from({ length: Number(to.slice(0, 4)) - Number(from.slice(0, 4)) + 3 }, (_, i) => Number(from.slice(0, 4)) - 1 + i);
  return years.filter(y => y >= Number(event.startDate.slice(0, 4))).map(y => {
    const date = inYear(event.startDate, y);
    let endDate = event.endDate ? inYear(event.endDate, y + Number(event.endDate.slice(0, 4)) - Number(event.startDate.slice(0, 4))) : null;
    if (event.precision === "month") {
      const end = endDate ?? date;
      endDate = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).toISOString().slice(0, 10);
    }
    return { date, endDate, outreachDate: shiftDay(date, -event.leadDays) };
  });
}
export function isEventOccurrence(event: Event, date: string): boolean {
  return validDate(date) && eventDates(event, date, date).some(o => o.date === date);
}
export function inWindow(date: string, end: string | null, outreach: string, from: string, to: string) {
  return (date <= to && (end ?? date) >= from) || (outreach >= from && outreach <= to);
}
