import { pool } from "@workspace/db";

/**
 * Live derivation of Chipply store ⇄ Printavo invoice links.
 *
 * Staff create $0 "merch" invoices per store per decoration method with the
 * nickname convention "<chipply_event_id> <Store Name> <METHOD>: ...", e.g.
 * "553498 Fuel Summer HEAT: Leg: Fuel Full logo". The nickname prefix is the
 * RELIABLE store identifier — the chipply URL in productionNote is often
 * absent or stale (copy-pasted from a prior season's store), so it is never
 * used for linking. Links are always derived live from nicknames (no link
 * table) so they self-heal as sync brings in new invoices.
 */

export interface ChipplyPrefixGroup {
  eventId: string;
  nameGuess: string;
  invoiceCount: number;
  latestVisualId: number;
  statuses: string[];
  customerId: string | null;
  customerCompany: string | null;
}

export const PREFIX_SQL_PATTERN = "^\\d{5,7}\\s"; // POSIX regex used in SQL

/**
 * SQL condition that is true when a row is NOT a Chipply-linked shell
 * invoice (nickname does not carry the event-id prefix). Chipply shells are
 * $0 merch invoices — they must never count toward customer spend/behavior
 * stats (order counts, frequency, quantities, top styles).
 */
export function notChipplySql(nicknameCol: string): string {
  return `(${nicknameCol} IS NULL OR ${nicknameCol} !~ '${PREFIX_SQL_PATTERN}')`;
}

/** Lowercase, collapse everything non-alphanumeric to single spaces. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Guess the store name from a nickname with the event-id prefix removed:
 * take the text before the first colon, then drop the trailing method token
 * ("Fuel Summer HEAT: Leg: ..." → "Fuel Summer"). If there is no colon the
 * whole remainder is used.
 */
export function guessStoreName(nicknameRest: string): string {
  const trimmed = nicknameRest.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return trimmed;
  const beforeColon = trimmed.slice(0, colonIdx).trim();
  const lastSpace = beforeColon.lastIndexOf(" ");
  if (lastSpace === -1) return beforeColon;
  return beforeColon.slice(0, lastSpace).trim() || beforeColon;
}

/** All event-id prefix groups in the mirror, newest first. */
export async function derivePrefixGroups(): Promise<ChipplyPrefixGroup[]> {
  const r = await pool.query(
    `SELECT substring(nickname from '^(\\d{5,7})\\s') AS event_id,
            (array_agg(nickname ORDER BY visual_id DESC))[1] AS latest_nickname,
            count(*)::int AS invoice_count,
            max(visual_id)::int AS latest_visual_id,
            array_agg(DISTINCT status_name) FILTER (WHERE status_name IS NOT NULL) AS statuses,
            mode() WITHIN GROUP (ORDER BY customer_id) AS customer_id,
            mode() WITHIN GROUP (ORDER BY customer_company) AS customer_company
     FROM pv_orders
     WHERE nickname ~ '${PREFIX_SQL_PATTERN}'
     GROUP BY 1
     ORDER BY max(visual_id) DESC`,
  );
  return r.rows.map((row) => {
    const latestNickname: string = row.latest_nickname ?? "";
    const rest = latestNickname.replace(/^\d{5,7}\s+/, "");
    return {
      eventId: row.event_id as string,
      nameGuess: guessStoreName(rest),
      invoiceCount: row.invoice_count as number,
      latestVisualId: row.latest_visual_id as number,
      statuses: (row.statuses ?? []) as string[],
      customerId: (row.customer_id ?? null) as string | null,
      customerCompany: (row.customer_company ?? null) as string | null,
    };
  });
}

/**
 * Ranked candidates for an email's store name: prefix groups whose guessed
 * name starts with the store name at a word boundary (normalized). This
 * deliberately surfaces close variants ("Fuel Summer" matches both
 * "Fuel Summer" and "Fuel Summer 2026") — staff picks in the UI. Ranked by
 * recency (latest visual id), exact-name matches first.
 */
export async function findCandidates(
  storeName: string,
): Promise<ChipplyPrefixGroup[]> {
  const target = normalizeName(storeName);
  if (!target) return [];
  const groups = await derivePrefixGroups();
  const matches = groups.filter((g) => {
    const name = normalizeName(g.nameGuess);
    return name === target || name.startsWith(`${target} `);
  });
  return matches.sort((a, b) => {
    const aExact = normalizeName(a.nameGuess) === target ? 1 : 0;
    const bExact = normalizeName(b.nameGuess) === target ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.latestVisualId - a.latestVisualId;
  });
}

/** Prefix groups with no imported chipply_stores row yet, newest first. */
export async function listDetectedGroups(): Promise<ChipplyPrefixGroup[]> {
  const [groups, existing] = await Promise.all([
    derivePrefixGroups(),
    pool.query(
      `SELECT event_id FROM chipply_stores WHERE event_id IS NOT NULL`,
    ),
  ]);
  const taken = new Set<string>(existing.rows.map((r) => r.event_id as string));
  return groups.filter((g) => !taken.has(g.eventId));
}

export interface LinkedInvoice {
  printavoId: string;
  visualId: number;
  nickname: string | null;
  statusName: string | null;
  total: string | null;
  invoiceAt: string | null;
}

export interface StyleAgg {
  brand: string | null;
  itemNumber: string | null;
  description: string | null;
  totalQty: number;
}

/** Invoices linked to an event id (nickname prefix match), newest first. */
export async function listLinkedInvoices(
  eventId: string,
): Promise<LinkedInvoice[]> {
  const r = await pool.query(
    `SELECT printavo_id, visual_id, nickname, status_name, total::text AS total,
            invoice_at::text AS invoice_at
     FROM pv_orders
     WHERE nickname LIKE $1
     ORDER BY visual_id DESC`,
    [`${eventId} %`],
  );
  return r.rows.map((row) => ({
    printavoId: row.printavo_id as string,
    visualId: row.visual_id as number,
    nickname: (row.nickname ?? null) as string | null,
    statusName: (row.status_name ?? null) as string | null,
    total: (row.total ?? null) as string | null,
    invoiceAt: (row.invoice_at ?? null) as string | null,
  }));
}

/** Style/qty aggregation across an event id's linked invoices. */
export async function aggregateStyles(eventId: string): Promise<StyleAgg[]> {
  const r = await pool.query(
    `SELECT li.brand, li.item_number, li.description,
            sum(li.items)::int AS total_qty
     FROM pv_line_items li
     JOIN pv_orders o ON o.printavo_id = li.order_id
     WHERE o.nickname LIKE $1
     GROUP BY li.brand, li.item_number, li.description
     ORDER BY sum(li.items) DESC
     LIMIT 50`,
    [`${eventId} %`],
  );
  return r.rows.map((row) => ({
    brand: (row.brand ?? null) as string | null,
    itemNumber: (row.item_number ?? null) as string | null,
    description: (row.description ?? null) as string | null,
    totalQty: row.total_qty as number,
  }));
}

/** Linked-invoice counts for many event ids in one query. */
export async function countLinkedInvoices(
  eventIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (eventIds.length === 0) return counts;
  const r = await pool.query(
    `SELECT substring(nickname from '^(\\d{5,7})\\s') AS event_id, count(*)::int AS n
     FROM pv_orders
     WHERE nickname ~ '${PREFIX_SQL_PATTERN}'
       AND substring(nickname from '^(\\d{5,7})\\s') = ANY($1)
     GROUP BY 1`,
    [eventIds],
  );
  for (const row of r.rows) counts.set(row.event_id as string, row.n as number);
  return counts;
}
