import { pool } from "@workspace/db";
import { INSIGHTS_TABLES } from "./guard";

/**
 * Schema documentation fed to the model. Hybrid approach:
 *  - column list introspected from information_schema at first use (always
 *    accurate, same whitelist as the DB grants — one source of truth)
 *  - hand-written semantics section for the domain rules a column list
 *    can't convey (revenue formulas, date storage quirks, jsonb casts).
 */

let cachedDoc: string | null = null;

/** Noise columns omitted from the doc (still granted, just not advertised). */
const OMIT_COLUMNS = new Set([
  "content_hash",
  "detail_content_hash",
  "extras_content_hash",
  "extras_stale",
  "extras_synced_at",
  "extras_attempted_at",
  "files_stale",
  "files_synced_at",
]);

const SEMANTICS = `
DOMAIN RULES (Mint Printworks — screen printing & embroidery shop, Printavo data):

Orders (pv_orders — one row per Printavo quote or invoice):
- order_type is 'invoice' or 'quote'. REVENUE = SUM(total) on order_type='invoice' ONLY (quotes are excluded from all revenue/sales reporting unless the user explicitly asks about quotes).
- visual_id is the human-facing order number (what staff call "#12345"). total and amount_outstanding are dollars.
- status_name is the CURRENT status. Status names often contain emoji and decorations (e.g. "🎨 Art Revision Needed"); ALWAYS match fuzzily and case-insensitively: status_name ILIKE '%revision%'.
- data (jsonb) is the raw Printavo blob — prefer the typed columns.

Dates & times (critical — two different kinds):
- CALENDAR dates from Printavo are stored at UTC midnight: customer_due_at, production_due_at (timestamptz), invoice_at, payment_due_at (date). Compare/bucket them in UTC: (customer_due_at AT TIME ZONE 'UTC')::date. Never convert these to local time.
- TRUE instants: printavo_created_at (record creation), change_events.occurred_at, synced_at, first_seen_at. Bucket these in shop-local time: (col AT TIME ZONE 'America/New_York')::date.
- "Created" for reporting = printavo_created_at unless the user asks about the (editable) invoice date, which is invoice_at.

Line items (pv_line_items, belongs to pv_line_item_groups via group_id, order via order_id → pv_orders.printavo_id):
- items = quantity; price = per-unit price; line revenue = price * items.
- item_number = style number (e.g. "PC61"); brand, color, category_name as labeled. sizes is a jsonb size→qty breakdown.

Payments (pv_payments — CASH-basis, separate from order revenue which is accrual):
- Payment totals = SUM(amount) bucketed by transaction_date (a plain date). typename distinguishes payment/refund types; order_visual_id links back to orders.

Status-change history (change_events):
- Audit feed observed by our sync engine — ONLY records changes since 2026-07-08 (nothing earlier exists). occurred_at is OBSERVATION time with ~5-minute poll granularity.
- Status changes: entity_type='order' AND event_type='status_change'. old_value/new_value are jsonb-encoded strings — extract with new_value #>> '{}' (e.g. WHERE new_value #>> '{}' ILIKE '%revision%').
- entity_id joins to pv_orders.printavo_id; visual_id is also populated directly.
- Counting "how many times did orders ENTER status X" = COUNT(*) of matching status_change rows; "how many DISTINCT orders" = COUNT(DISTINCT entity_id).

Customers (pv_customers) & niches:
- Display name: coalesce(nullif(company_name,''), data->'primaryContact'->>'fullName').
- Niche categories: customer_meta.printavo_customer_id → pv_customers.printavo_id; customer_meta.category_id → customer_categories.id (name = niche name).

Chipply web stores (chipply_stores + chipply_store_styles — a SEPARATE sales channel):
- Chipply is an online team-store platform; each row in chipply_stores is one web store (event_id is the Chipply order number staff quote, store_name like "Fuel Summer").
- HARD RULE: Chipply dollars are NEVER combined with Printavo revenue. Never add chipply_stores money to pv_orders totals; report them as separate lines. Printavo invoices whose nickname starts with the store's event_id are $0 production shells — their revenue lives ONLY in chipply_stores.
- total_dollars = sell price (combined_price + size_upcharges + fundraising). order_total additionally includes shipping/handling/tax — they are DIFFERENT numbers; "store sales" = total_dollars unless the user asks about collected totals.
- fundraising = the org's cut; product_cost/chipply_fee/cc_processing_fee are costs. Shop-side margin ≈ total_dollars - fundraising - product_cost - chipply_fee - cc_processing_fee.
- pv_customer_id links to pv_customers.printavo_id (which customer the store belongs to). closed_at/opened_at are plain dates.
- chipply_store_styles (store_id → chipply_stores.id) = per-style rows from Chipply's margin report: purchases, total_sale, total_cost, total_profit are Chipply-side numbers, NOT Printavo line items.
- Exclude archived stores (archived = false) unless asked otherwise.

General:
- Money columns are numeric dollars — round with ::numeric(12,2) when presenting.
- Results are capped at ${500} rows — always aggregate rather than listing raw rows when the question asks for counts/totals.
`;

export async function getSchemaDoc(): Promise<string> {
  if (cachedDoc) return cachedDoc;
  const res = await pool.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [[...INSIGHTS_TABLES]],
  );
  const byTable = new Map<string, string[]>();
  for (const row of res.rows) {
    if (OMIT_COLUMNS.has(row.column_name as string)) continue;
    const list = byTable.get(row.table_name as string) ?? [];
    list.push(`${row.column_name} ${row.data_type}`);
    byTable.set(row.table_name as string, list);
  }
  const tables = [...byTable.entries()]
    .map(([name, cols]) => `TABLE ${name}\n  ${cols.join(", ")}`)
    .join("\n\n");
  cachedDoc = `AVAILABLE TABLES (PostgreSQL — these are the ONLY tables you may query):\n\n${tables}\n\n${SEMANTICS}`;
  return cachedDoc;
}
