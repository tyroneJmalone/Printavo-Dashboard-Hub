import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { eventSchema, eventDates, inYear, validateValue, naturalKey, type Field } from "../src/lib/sales/policy";
import { saveRecord, archiveRecord } from "../src/lib/sales/store";
import { salesWorkspace } from "../src/lib/sales/workspace";
import { salesHistory } from "../src/lib/sales/history";

const niche = "11111111-1111-4111-8111-111111111111";
const event = { title: "Baseball", startDate: "2026-04-01", endDate: null, precision: "day", recurrence: "annual", leadDays: 42, nicheIds: [niche], customerIds: [], owner: "sales@example.test", notes: "", merchandise: "Caps" };
const field: Field = { name: "Birthday", scope: "contact", type: "annual_date", options: [], reminderEnabled: true, leadDays: 7 };
before(async () => {
  const schema = process.env.SALES_TEST_SCHEMA!;
  assert.match(schema, /^sales_test_\d+$/);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(readFileSync(process.env.SALES_DDL!, "utf8"));
  await pool.query(`
    CREATE TABLE pv_customers(printavo_id text PRIMARY KEY,company_name text,data jsonb);
    CREATE TABLE customer_meta(printavo_customer_id text,category_id uuid);
    CREATE TABLE customer_categories(id uuid,name text,active boolean);
    CREATE TABLE pv_contacts(printavo_id text,customer_id text,full_name text);
    CREATE TABLE pv_orders(printavo_id text,visual_id int,customer_id text,order_type text,nickname text,owner_email text,invoice_at date,customer_due_at timestamptz,total numeric,status_name text);
    CREATE TABLE pv_line_items(order_id text,items int);
    INSERT INTO pv_customers VALUES('1','School','{}'),('2','Club','{}');
    INSERT INTO customer_meta VALUES('1','${niche}');
    INSERT INTO customer_categories VALUES('${niche}','Schools',true);
    INSERT INTO pv_contacts VALUES('10','1','Test Contact'),('20','2','Other Contact');
    INSERT INTO pv_orders VALUES('100',100,'1','invoice','Annual event','sales@example.test','2025-04-01','2025-04-10',100,'Complete'),
      ('101',101,'1','invoice','New order','other@example.test','2026-02-01','2026-02-10',200,'Complete'),
      ('102',102,'1','quote','New quote','sales@example.test','2026-03-01',NULL,300,'Pending');
    INSERT INTO pv_line_items VALUES('100',12);
  `);
});
after(async () => {
  await pool.query(`DROP SCHEMA "${process.env.SALES_TEST_SCHEMA}" CASCADE`);
  await pool.end();
});
async function tx<T>(fn: (c: any) => Promise<T>) {
  const c = await pool.connect(); await c.query("BEGIN");
  try { const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (err) { await c.query("ROLLBACK"); throw err; }
  finally { c.release(); }
}
const save = (input: any, admin = true) => tx(c => saveRecord(c, input, "tester@example.test", admin));
test("dates reject invalid dates, annual events handle leap years and year-spanning ranges", () => {
  assert.equal(eventSchema.safeParse({ ...event, startDate: "2026-02-30" }).success, false);
  assert.equal(eventSchema.safeParse({ ...event, nicheIds: [] }).success, false);
  assert.equal(inYear("2024-02-29", 2025), "2025-02-28");
  const dates = eventDates(eventSchema.parse({ ...event, startDate: "2025-12-28", endDate: "2026-01-04" }), "2026-12-01", "2027-02-01");
  assert.ok(dates.some(d => d.date === "2026-12-28" && d.endDate === "2027-01-04"));
  const month = eventDates(eventSchema.parse({ ...event, precision: "month" }), "2026-04-15", "2026-04-20");
  assert.ok(month.some(d => d.date === "2026-04-01" && d.endDate === "2026-04-30"));
});
test("custom fields enforce personal scope, dates and exact typed values", () => {
  assert.ok(validateValue(field, { fieldId: "x", customerId: "1", contactId: "10", value: "02-29" }));
  assert.equal(validateValue(field, { fieldId: "x", customerId: "1", contactId: null, value: "02-29" }), false);
  assert.equal(validateValue(field, { fieldId: "x", customerId: "1", contactId: "10", value: "02-30" }), false);
  assert.equal(validateValue({ ...field, type: "number" }, { fieldId: "x", customerId: "1", contactId: "10", value: "NaN" }), false);
});
test("events inherit from niches, support per-client overrides and restore without automatic tasks", async () => {
  const e = await save({ kind: "event", event });
  let w = await salesWorkspace({ from: "2026-03-01", to: "2026-05-01", customerId: "1" });
  assert.equal(w.occurrences[0].inherited, true);
  assert.equal(w.followups.length, 0);
  const override = { eventId: e.id, customerId: "1", occurrenceDate: "2026-04-01", excluded: true, startDate: "2026-04-08", notes: "Not participating" };
  const o = await save({ kind: "override", override });
  w = await salesWorkspace({ from: "2026-03-01", to: "2026-05-01", customerId: "1" });
  assert.equal(w.occurrences[0].excluded, true);
  assert.equal(w.occurrences[0].date, "2026-04-08");
  await tx(c => archiveRecord(c, { id: o.id, version: 1 }, "tester", true));
  w = await salesWorkspace({ from: "2026-03-01", to: "2026-05-01", customerId: "1" });
  assert.equal(w.occurrences[0].excluded, false);
  await assert.rejects(save({ kind: "event", id: e.id, version: 0, event }), /changed/);
  await assert.rejects(save({ kind: "override", override: { ...override, occurrenceDate: "2026-04-02" } }), /actual occurrence/);
  await save({ kind: "override", override: { ...override, excluded: false, startDate: "2028-10-15" } });
  w = await salesWorkspace({ from: "2028-10-01", to: "2028-10-30", customerId: "1" });
  assert.ok(w.occurrences.some(o => o.date === "2028-10-15" && o.originalDate === "2026-04-01"));
});
test("field definitions admin-only; contact ownership and typed validation, archival preserves values", async () => {
  await assert.rejects(save({ kind: "field", field }, false), /administrators/);
  const f = await save({ kind: "field", field });
  await assert.rejects(save({ kind: "value", value: { fieldId: f.id, customerId: "1", contactId: "20", value: "04-10" } }), /belong/);
  const v = await save({ kind: "value", value: { fieldId: f.id, customerId: "1", contactId: "10", value: "04-10" } });
  const reminder = await save({ kind: "followup", followup: { customerId: "1", title: "Birthday reminder", dueDate: "2026-04-03", status: "needs_contact", owner: "", notes: "", sourceType: "custom_field", sourceId: v.id, occurrenceDate: "2026-04-10", invoiceIds: [] } });
  assert.equal((await pool.query("SELECT payload FROM sales_records WHERE id=$1", [reminder.id])).rows[0].payload.contactId, "10");
  let w = await salesWorkspace({ from: "2026-04-01", to: "2026-04-30", customerId: "1" });
  assert.ok(w.occurrences.some(o => o.sourceType === "custom_field" && o.outreachDate === "2026-04-03"));
  await assert.rejects(save({ kind: "field", id: f.id, version: 1, field: { ...field, type: "text", reminderEnabled: false } }), /type or scope/);
  await tx(c => archiveRecord(c, { id: f.id, version: 1 }, "tester", true));
  w = await salesWorkspace({ from: "2026-04-01", to: "2026-04-30", customerId: "1" });
  assert.equal(w.values.length, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM sales_records WHERE kind='value'")).rows[0].n, 1);
});
test("follow-ups deduplicate concurrent creation, reject stale edits, retain provenance and audit", async () => {
  const followup = { customerId: "1", title: "Call", dueDate: "2026-03-01", status: "needs_contact", owner: "sales@example.test", notes: "", sourceType: "anniversary", sourceId: "100", occurrenceDate: "2026-04-01", invoiceIds: ["100"] };
  const results = await Promise.allSettled([save({ kind: "followup", followup }), save({ kind: "followup", followup })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const id = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<{id:string}>).value.id;
  await save({ kind: "followup", id, version: 1, followup: { ...followup, status: "snoozed", dueDate: "2026-04-01", notes: "Call later" } });
  await assert.rejects(save({ kind: "followup", id, version: 1, followup }), /changed/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM sales_record_activity WHERE record_id=$1", [id])).rows[0].n, 2);
  assert.equal(naturalKey("followup", followup), naturalKey("followup", { ...followup, owner: "other@example.test" }));
});
test("history groups invoices with quantities and newer-order/quote context, date basis and owner filters", async () => {
  const history = await salesHistory({ from: "2025-04-01", to: "2025-04-30", offset: 0, owner: "sales@example.test", nicheId: niche });
  assert.equal(history.customers.length, 1);
  const c = history.customers[0];
  assert.equal(c.invoices[0].quantity, 12);
  assert.equal(c.latestOrderDate, "2026-02-01");
  assert.equal(c.activeQuoteCount, 1);
  assert.equal((await salesHistory({ from: "2025-04-10", to: "2025-04-10", dateBasis: "customerDue", offset: 0 })).customers.length, 1);
  assert.equal((await salesHistory({ from: "2025-04-10", to: "2025-04-10", offset: 0 })).customers.length, 0);
});
