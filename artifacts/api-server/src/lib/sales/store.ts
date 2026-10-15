import { pool } from "@workspace/db";
type PoolClient = Pick<typeof pool, "query">;
import { schemas, naturalKey, validateValue, isEventOccurrence, type Kind, type RecordRow } from "./policy";

export class SalesError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function reference(client: PoolClient, id: string, kind: Kind): Promise<RecordRow> {
  const r = await client.query("SELECT * FROM sales_records WHERE id=$1 AND kind=$2 AND NOT archived FOR SHARE", [id, kind]);
  if (!r.rows[0]) throw new SalesError(400, `The selected ${kind} is no longer available`);
  return r.rows[0];
}
async function customer(client: PoolClient, id: string) {
  const r = await client.query("SELECT c.printavo_id, m.category_id FROM pv_customers c LEFT JOIN customer_meta m ON m.printavo_customer_id=c.printavo_id WHERE c.printavo_id=$1", [id]);
  if (!r.rows[0]) throw new SalesError(400, "Customer not found");
  return r.rows[0];
}
async function audience(client: PoolClient, event: any, id: string) {
  const c = await customer(client, id);
  if (!event.customerIds.includes(id) && !event.nicheIds.includes(c.category_id)) throw new SalesError(400, "Customer is not in this event's audience");
}
export async function saveRecord(client: PoolClient, input: any, actor: string, admin: boolean) {
  if (!input || !Object.hasOwn(schemas, input.kind)) throw new SalesError(400, "Invalid record kind");
  const kind = input.kind as Kind;
  if (kind === "field" && !admin) throw new SalesError(403, "Only administrators can manage field definitions");
  const parsed = schemas[kind].safeParse(input[kind]);
  if (!parsed.success) throw new SalesError(400, parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const data: any = parsed.data;
  let old: RecordRow | undefined;
  if (input.id) {
    if (!/^[0-9a-f-]{36}$/i.test(input.id) || !Number.isInteger(input.version)) throw new SalesError(400, "Edits require an id and version");
    const r = await client.query("SELECT * FROM sales_records WHERE id=$1 FOR UPDATE", [input.id]);
    old = r.rows[0];
    if (!old || old.archived || old.kind !== kind || old.version !== input.version)
      throw new SalesError(409, "This record changed or was archived. Reload before editing.");
  }
  if (data.customerId) await customer(client, data.customerId);
  if (data.contactId) {
    const r = await client.query("SELECT 1 FROM pv_contacts WHERE printavo_id=$1 AND customer_id=$2", [data.contactId, data.customerId]);
    if (!r.rowCount) throw new SalesError(400, "Contact does not belong to this customer");
  }
  if (kind === "event") {
    const clients = await client.query("SELECT printavo_id FROM pv_customers WHERE printavo_id=ANY($1::text[])", [data.customerIds]);
    const niches = await client.query("SELECT id FROM customer_categories WHERE id=ANY($1::uuid[]) AND active", [data.nicheIds]);
    if (clients.rowCount !== new Set(data.customerIds).size || niches.rowCount !== new Set(data.nicheIds).size)
      throw new SalesError(400, "A selected customer or active niche no longer exists");
  }
  if (kind === "value") {
    const field = await reference(client, data.fieldId, "field");
    if (!validateValue(field.payload, data)) throw new SalesError(400, "Value does not match this field's type, scope, or dropdown options");
  }
  if (kind === "field" && old) {
    const values = await client.query("SELECT payload FROM sales_records WHERE kind='value' AND NOT archived AND payload->>'fieldId'=$1", [old.id]);
    if (values.rowCount && (old.payload.scope !== data.scope || old.payload.type !== data.type))
      throw new SalesError(409, "This field has saved values. Create a new field to change its type or scope.");
    if (values.rows.some(r => !validateValue(data, r.payload)))
      throw new SalesError(409, "Existing values use an option you removed. Update those values first.");
  }
  if (kind === "override") {
    const event = await reference(client, data.eventId, "event");
    await audience(client, event.payload, data.customerId);
    if (!isEventOccurrence(event.payload, data.occurrenceDate)) throw new SalesError(400, "Choose an actual occurrence of this event");
  }
  if (kind === "followup") {
    // Preserve source identity after creation, including duplicate-prevention keys.
    if (old && ["customerId", "sourceType", "sourceId", "occurrenceDate"].some(k => old!.payload[k] !== data[k]))
      throw new SalesError(409, "A follow-up's customer and source cannot change; create a new follow-up instead.");
    if (data.invoiceIds.length) {
      const invoices = await client.query("SELECT printavo_id FROM pv_orders WHERE printavo_id=ANY($1::text[]) AND customer_id=$2 AND order_type='invoice'", [data.invoiceIds, data.customerId]);
      if (invoices.rowCount !== new Set(data.invoiceIds).size) throw new SalesError(400, "An invoice does not belong to this customer");
    }
    if (!old && data.sourceType === "event") {
      const event = await reference(client, data.sourceId, "event");
      await audience(client, event.payload, data.customerId);
      if (!isEventOccurrence(event.payload, data.occurrenceDate)) throw new SalesError(400, "Choose an actual occurrence of this event");
      const excluded = await client.query("SELECT 1 FROM sales_records WHERE kind='override' AND NOT archived AND payload->>'eventId'=$1 AND customer_id=$2 AND payload->>'occurrenceDate'=$3 AND payload->>'excluded'='true'", [data.sourceId, data.customerId, data.occurrenceDate]);
      if (excluded.rowCount) throw new SalesError(409, "This event occurrence is excluded for this customer");
    }
    if (!old && data.sourceType === "custom_field") {
      const value = await reference(client, data.sourceId, "value");
      if (value.customer_id !== data.customerId) throw new SalesError(400, "Reminder belongs to another customer");
      const field = await reference(client, value.payload.fieldId, "field");
      if (!field.payload.reminderEnabled || !value.payload.value) throw new SalesError(400, "This field no longer has an enabled reminder");
      // Preserve the person behind a birthday/reminder for future manual email integration.
      data.contactId = value.payload.contactId;
      if (data.contactId) {
        const contact = await client.query("SELECT 1 FROM pv_contacts WHERE printavo_id=$1 AND customer_id=$2", [data.contactId, data.customerId]);
        if (!contact.rowCount) throw new SalesError(400, "The reminder contact no longer belongs to this customer");
      }
    }
    if (!old && data.sourceType === "anniversary") {
      const r = await client.query("SELECT 1 FROM pv_orders WHERE printavo_id=$1 AND customer_id=$2 AND order_type='invoice'", [data.sourceId, data.customerId]);
      if (!r.rowCount) throw new SalesError(400, "Anniversary source must be this customer's invoice");
    }
  }
  const key = naturalKey(kind, data);
  const r = old
    ? await client.query("UPDATE sales_records SET payload=$2,customer_id=$3,natural_key=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING id", [old.id, data, data.customerId ?? null, key])
    : await client.query("INSERT INTO sales_records(kind,customer_id,natural_key,payload) VALUES($1,$2,$3,$4) RETURNING id", [kind, data.customerId ?? null, key, data]);
  const recordId = r.rows[0].id;
  await client.query("INSERT INTO sales_record_activity(record_id,actor,action,snapshot) VALUES($1,$2,$3,$4)", [recordId, actor, old ? "updated" : "created", { kind, data, version: (old?.version ?? 0) + 1 }]);
  return { id: recordId };
}
export async function archiveRecord(client: PoolClient, input: any, actor: string, admin: boolean) {
  if (!input || !/^[0-9a-f-]{36}$/i.test(input.id) || !Number.isInteger(input.version)) throw new SalesError(400, "An id and version are required");
  const r = await client.query("SELECT * FROM sales_records WHERE id=$1 FOR UPDATE", [input.id]);
  const row: RecordRow | undefined = r.rows[0];
  if (!row || row.archived || row.version !== input.version) throw new SalesError(409, "This record changed. Reload before archiving.");
  if (row.kind === "field" && !admin) throw new SalesError(403, "Only administrators can archive field definitions");
  await client.query("UPDATE sales_records SET archived=true,version=version+1,updated_at=now() WHERE id=$1", [row.id]);
  await client.query("INSERT INTO sales_record_activity(record_id,actor,action,snapshot) VALUES($1,$2,'archived',$3)", [row.id, actor, { kind: row.kind, data: row.payload, version: row.version + 1 }]);
  return { ok: true };
}
