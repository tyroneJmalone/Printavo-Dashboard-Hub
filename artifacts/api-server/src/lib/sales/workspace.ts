import { pool } from "@workspace/db";
import { eventDates, inWindow, inYear, shiftDay, type RecordRow, type Event, type Value, type Field, type Override } from "./policy";
import { SalesError } from "./store";

export interface WindowFilter { from: string; to: string; customerId?: string; owner?: string; nicheId?: string }
const displayName = "coalesce(nullif(c.company_name,''),c.data->'primaryContact'->>'fullName','(no name)')";

export async function salesWorkspace(filter: WindowFilter) {
  const result = await pool.query("SELECT * FROM sales_records WHERE NOT archived ORDER BY created_at,id LIMIT 10001");
  if (result.rows.length > 10000) throw new SalesError(413, "Sales workspace exceeds its current capacity. Contact an administrator; no records were omitted.");
  const records = result.rows as RecordRow[];
  const ids = new Set<string>(filter.customerId ? [filter.customerId] : []);
  records.forEach(r => {
    if (r.customer_id) ids.add(r.customer_id);
    if (r.kind === "event") r.payload.customerIds.forEach((id: string) => ids.add(id));
  });
  const clients = await pool.query(`SELECT c.printavo_id AS id,${displayName} AS name,m.category_id FROM pv_customers c LEFT JOIN customer_meta m ON m.printavo_customer_id=c.printavo_id WHERE c.printavo_id=ANY($1::text[])`, [[...ids]]);
  const byCustomer = new Map(clients.rows.map(c => [c.id, c]));
  const niches = await pool.query("SELECT id,parent_id FROM customer_categories");
  const parentById = new Map<string, string | null>(niches.rows.map(n => [n.id, n.parent_id]));
  const nicheMatches = (assigned: string | undefined, target: string) =>
    Boolean(assigned && (assigned === target || parentById.get(assigned) === target));
  const audienceMatches = (assigned: string | undefined, audience: string[]) =>
    audience.some(n => nicheMatches(assigned, n));
  if (filter.customerId && !byCustomer.has(filter.customerId)) throw new SalesError(404, "Customer not found");
  const clientMatches = (id: string) => (!filter.customerId || id === filter.customerId) && (!filter.nicheId || nicheMatches(byCustomer.get(id)?.category_id, filter.nicheId));
  const ownerMatches = (owner: string) => !filter.owner || owner === filter.owner.toLowerCase();
  const wrap = (r: RecordRow) => ({ id: r.id, version: r.version, [r.kind]: r.payload });
  const fields = records.filter(r => r.kind === "field");
  const fieldsById = new Map(fields.map(f => [f.id, f.payload as Field]));
  const overrides = records.filter(r => r.kind === "override");
  const events = records.filter(r => r.kind === "event" && ownerMatches(r.payload.owner)
    && (!filter.nicheId || r.payload.nicheIds.some((n: string) => nicheMatches(n, filter.nicheId!) || nicheMatches(filter.nicheId, n)) || r.payload.customerIds.some((id: string) => nicheMatches(byCustomer.get(id)?.category_id, filter.nicheId!)))
    && (!filter.customerId || r.payload.customerIds.includes(filter.customerId) || audienceMatches(byCustomer.get(filter.customerId)?.category_id, r.payload.nicheIds)));
  const occurrences: any[] = [];
  for (const row of events) {
    const event = row.payload as Event;
    const dates = new Map(eventDates(event, filter.from, filter.to).map(o => [o.date, o]));
    // A client may move an occurrence across years; keep it discoverable in its new window.
    for (const override of overrides.filter(r => r.customer_id === filter.customerId && r.payload.eventId === row.id)) {
      const original = override.payload.occurrenceDate;
      const occurrence = eventDates(event, original, original).find(o => o.date === original);
      if (occurrence) dates.set(original, occurrence);
    }
    for (const occurrence of dates.values()) {
      const override = filter.customerId ? overrides.find(r => r.payload.eventId === row.id && r.customer_id === filter.customerId && r.payload.occurrenceDate === occurrence.date)?.payload as Override | undefined : undefined;
      const date = override?.startDate ?? occurrence.date;
      const endDate = occurrence.endDate ? shiftDay(date, Math.round((Date.parse(occurrence.endDate) - Date.parse(occurrence.date)) / 86400000)) : null;
      const outreachDate = shiftDay(date, -event.leadDays);
      if (!inWindow(date, endDate, outreachDate, filter.from, filter.to)) continue;
      occurrences.push({
        key: `${row.id}:${occurrence.date}:${filter.customerId ?? "all"}`, sourceType: "event", sourceId: row.id,
        title: event.title, date, endDate, outreachDate, precision: event.precision,
        customerId: filter.customerId ?? null, inherited: Boolean(filter.customerId && !event.customerIds.includes(filter.customerId)),
        excluded: override?.excluded ?? false, originalDate: occurrence.date, owner: event.owner,
      });
    }
  }
  const valueRecords = records.filter(r => r.kind === "value" && fieldsById.has(r.payload.fieldId) && clientMatches(r.customer_id!));
  const contactIds = valueRecords.map(r => r.payload.contactId).filter(Boolean);
  const contactRows = await pool.query("SELECT printavo_id AS id,coalesce(full_name,'Unnamed contact') AS name FROM pv_contacts WHERE printavo_id=ANY($1::text[]) OR ($2::text IS NOT NULL AND customer_id=$2)", [contactIds, filter.customerId ?? null]);
  const contacts = new Map(contactRows.rows.map(c => [c.id, c.name]));
  if (!filter.owner) for (const row of valueRecords) {
    const value = row.payload as Value;
    const field = fieldsById.get(value.fieldId)!;
    if (!field.reminderEnabled || !value.value) continue;
    const dates = field.type === "annual_date"
      ? Array.from({ length: Number(filter.to.slice(0, 4)) - Number(filter.from.slice(0, 4)) + 2 }, (_, i) => inYear(`2000-${value.value}`, Number(filter.from.slice(0, 4)) + i))
      : [value.value];
    for (const date of dates) {
      const outreachDate = shiftDay(date, -field.leadDays);
      if (!inWindow(date, null, outreachDate, filter.from, filter.to)) continue;
      occurrences.push({
        key: `${row.id}:${date}`, sourceType: "custom_field", sourceId: row.id,
        title: `${field.name} — ${value.contactId ? contacts.get(value.contactId) ?? "Contact" : byCustomer.get(value.customerId)?.name ?? "Customer"}`,
        date, endDate: null, outreachDate, precision: "day", customerId: value.customerId,
        inherited: false, excluded: false, originalDate: date, owner: "",
      });
    }
  }
  const owners = await pool.query("SELECT DISTINCT lower(owner_email) AS owner FROM pv_orders WHERE owner_email IS NOT NULL AND owner_email<>'' ORDER BY owner");
  const allOwners = new Set<string>(owners.rows.map(r => r.owner));
  records.forEach(r => { if (r.payload.owner) allOwners.add(r.payload.owner); });
  return {
    events: events.map(wrap),
    followups: records.filter(r => r.kind === "followup" && clientMatches(r.customer_id!) && ownerMatches(r.payload.owner)).map(wrap),
    fields: fields.map(wrap),
    values: filter.customerId ? valueRecords.map(wrap) : [],
    overrides: overrides.filter(r => clientMatches(r.customer_id!)).map(wrap),
    occurrences: occurrences.sort((a, b) => a.date.localeCompare(b.date)),
    customers: clients.rows.map(c => ({ id: c.id, name: c.name })),
    contacts: filter.customerId ? contactRows.rows : [],
    owners: [...allOwners].sort(),
  };
}
