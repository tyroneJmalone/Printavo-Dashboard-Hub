/**
 * Parser for pasted Chipply "Web Store Closed" notification emails.
 *
 * Pure function (no DB / network) so it can be harness-tested directly.
 * Built tolerant: every field is independently optional — a miss returns
 * null for that field and the UI lets staff fill it in, so a format change
 * on Chipply's side degrades gracefully instead of failing the import.
 */

export interface ChipplyParsedEmail {
  storeName: string | null;
  orgContact: string | null;
  storeAdmin: string | null;
  /** YYYY-MM-DD (calendar date — no timezone math) */
  closedAt: string | null;
  numOrders: number | null;
  numProducts: number | null;
  totalDollars: number | null;
  fundraising: number | null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function cleanLineValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.replace(/\s+/g, " ").trim();
  return v.length > 0 && v.length <= 200 ? v : null;
}

function parseIntSafe(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseMoney(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** "Jul 6, 2026" / "July 06, 2026" → "2026-07-06" */
function parseUsDate(text: string): string | null {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = Number.parseInt(m[2], 10);
  const year = Number.parseInt(m[3], 10);
  if (day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseChipplyEmail(text: string): ChipplyParsedEmail {
  // Store name: "<Store Name> - Web Store Closed" (subject line and/or the
  // banner heading). Take the shortest plausible match so a "Subject: Fwd: "
  // prefix doesn't leak into the name.
  let storeName: string | null = null;
  const nameRe = /^[ \t]*(?:Subject:\s*)?(?:Fwd?:\s*|Re:\s*)*(.{2,120}?)\s*[-–—]\s*Web\s*Store\s*Closed\b/gim;
  for (const m of text.matchAll(nameRe)) {
    const candidate = cleanLineValue(m[1]);
    if (candidate && (storeName === null || candidate.length < storeName.length)) {
      storeName = candidate;
    }
  }

  const orgContact = cleanLineValue(
    /Organization\s*Contact:\s*([^\r\n]+)/i.exec(text)?.[1],
  );
  const storeAdmin = cleanLineValue(
    /Store\s*Admin:\s*([^\r\n]+)/i.exec(text)?.[1],
  );
  const numOrders = parseIntSafe(
    /Number\s*of\s*Orders:\s*([\d,]+)/i.exec(text)?.[1],
  );
  const numProducts = parseIntSafe(
    /Number\s*of\s*Products:\s*([\d,]+)/i.exec(text)?.[1],
  );
  const totalDollars = parseMoney(
    /Total\s*Dollars:\s*(\$?\s*[\d,]+(?:\.\d{1,2})?)/i.exec(text)?.[1],
  );
  const fundraising = parseMoney(
    /Fundraising:\s*(\$?\s*[\d,]+(?:\.\d{1,2})?)/i.exec(text)?.[1],
  );

  // Closed date: the email header timestamp is usually the first date-looking
  // string in the pasted text (e.g. "Jul 6, 2026, 12:00 AM").
  const closedAt = parseUsDate(text);

  return {
    storeName,
    orgContact,
    storeAdmin,
    closedAt,
    numOrders,
    numProducts,
    totalDollars,
    fundraising,
  };
}

/** True when the parse found nothing usable at all. */
export function isEmptyParse(p: ChipplyParsedEmail): boolean {
  return (
    p.storeName === null &&
    p.orgContact === null &&
    p.storeAdmin === null &&
    p.numOrders === null &&
    p.numProducts === null &&
    p.totalDollars === null &&
    p.fundraising === null
  );
}
