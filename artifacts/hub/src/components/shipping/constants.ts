// Ported from shipstimator (Shipment-Calculator) shared/schema.ts + pages/home.tsx

export const presetBoxes = [
  { id: "small_flat", name: "USPS Small Flat Rate Box", length: 8.625, width: 5.375, height: 1.625, carrier: "usps" },
  { id: "medium_flat_1", name: "USPS Medium Flat Rate Box (Top Loading)", length: 11.25, width: 8.75, height: 6, carrier: "usps" },
  { id: "medium_flat_2", name: "USPS Medium Flat Rate Box (Side Loading)", length: 14, width: 12, height: 3.5, carrier: "usps" },
  { id: "large_flat", name: "USPS Large Flat Rate Box", length: 12.25, width: 12.25, height: 6, carrier: "usps" },
  { id: "ups_small", name: "UPS Express Box - Small", length: 13, width: 11, height: 2, carrier: "ups" },
  { id: "ups_medium", name: "UPS Express Box - Medium", length: 16, width: 11, height: 3, carrier: "ups" },
  { id: "ups_large", name: "UPS Express Box - Large", length: 18, width: 13, height: 3, carrier: "ups" },
  { id: "std_small", name: "Small Standard", length: 16, width: 12, height: 8, carrier: "all" },
  { id: "std_medium", name: "Medium Standard", length: 18, width: 12, height: 12, carrier: "all" },
  { id: "std_large", name: "Large Standard", length: 24, width: 16, height: 12, carrier: "all" },
  { id: "custom", name: "Custom Dimensions", length: 0, width: 0, height: 0, carrier: "all" },
] as const;

export type PresetBox = (typeof presetBoxes)[number];

export const US_STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" }, { code: "DC", name: "District of Columbia" },
];

const STATE_NAME_TO_CODE: Record<string, string> = {};
US_STATES.forEach((s) => {
  STATE_NAME_TO_CODE[s.name.toLowerCase()] = s.code;
  STATE_NAME_TO_CODE[s.code.toLowerCase()] = s.code;
});

const STATE_KEYS_BY_LENGTH = Object.keys(STATE_NAME_TO_CODE).sort((a, b) => b.length - a.length);

const COUNTRY_LINE = /^(usa?|u\.s\.a?\.?|united states( of america)?)\.?$/i;
const PHONE_LINE = /^(tel|phone|ph|mobile|cell|fax)?[:.\s]*[+(]?[\d\s().\-+]{7,}(\s*(x|ext\.?)\s*\d+)?$/i;
const ZIP_ONLY_LINE = /^\d{5}(?:-\d{4})?$/;
const STREET_LINE = /^\d+[a-zA-Z]?([-/]\d+[a-zA-Z]?)?\s+\S|^p\.?\s*o\.?\s*box\b|^post office box\b|^(rr|hc)\s*\d+\b/i;

/** Try to read "City, ST 12345" / "City ST 12345" / "City, State Name 12345" from one line. */
function matchCityStateZip(
  line: string
): { city: string; state: string; postalCode: string } | null {
  const m = line.match(/^(.+?)[\s,]+(\d{5}(?:-\d{4})?)$/);
  if (!m) return null;
  const postalCode = m[2];
  let rest = m[1].trim().replace(/[.,]+$/, "").trim();

  for (const key of STATE_KEYS_BY_LENGTH) {
    const lower = rest.toLowerCase();
    if (lower === key) return null; // state with no city
    if (lower.endsWith(" " + key) || lower.endsWith("," + key) || lower.endsWith(", " + key)) {
      const city = rest
        .slice(0, rest.length - key.length)
        .replace(/[\s,]+$/, "")
        .trim();
      if (!city) return null;
      return { city, state: STATE_NAME_TO_CODE[key], postalCode };
    }
  }
  return null;
}

/**
 * Parse a pasted address block into fields. Tolerates common variations:
 * - recipient name and/or company lines before the street
 * - phone, email, and country ("USA", "United States") lines
 * - "City, ST 12345", "City ST 12345", "City, State Name 12345", ZIP+4
 * - ZIP on its own line after "City, ST"
 * - single-line addresses ("9355 Burton Way, Beverly Hills, CA 90210")
 * - apt/suite on its own line (goes to street2)
 */
export function parseBlockAddress(
  text: string
): { street1: string; street2: string; city: string; state: string; postalCode: string } | null {
  let lines = text
    .trim()
    .split(/\n/)
    .map((l) => l.trim().replace(/^[-•*]\s*/, ""))
    .filter(Boolean)
    .filter((l) => !COUNTRY_LINE.test(l))
    .filter((l) => !l.includes("@"))
    .filter((l) => ZIP_ONLY_LINE.test(l) || !PHONE_LINE.test(l));
  if (lines.length === 0) return null;

  // Single-line paste: break on commas so "street, city, ST zip" works.
  if (lines.length === 1) {
    lines = lines[0].split(",").map((p) => p.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    // Re-attach state/zip fragments to the city ("Beverly Hills" + "CA 90210").
    while (lines.length > 2 && !matchCityStateZip(lines[lines.length - 1])) {
      const tail = lines.pop() as string;
      lines[lines.length - 1] = `${lines[lines.length - 1]}, ${tail}`;
    }
    if (lines.length >= 2) {
      const merged = `${lines[lines.length - 2]}, ${lines[lines.length - 1]}`;
      if (!matchCityStateZip(lines[lines.length - 1]) && matchCityStateZip(merged)) {
        lines.splice(lines.length - 2, 2, merged);
      }
    }
  }

  // ZIP on its own line: merge it into the previous line.
  if (lines.length >= 2 && ZIP_ONLY_LINE.test(lines[lines.length - 1])) {
    const zip = lines.pop() as string;
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${zip}`;
  }

  if (lines.length < 2) return null;

  // Find the city/state/zip line, scanning from the bottom.
  let cityIdx = -1;
  let cityStateZip: { city: string; state: string; postalCode: string } | null = null;
  for (let i = lines.length - 1; i >= 1; i--) {
    const parsed = matchCityStateZip(lines[i]);
    if (parsed) {
      cityIdx = i;
      cityStateZip = parsed;
      break;
    }
  }
  if (!cityStateZip || cityIdx < 1) return null;

  const candidates = lines.slice(0, cityIdx);

  // First line that looks like a street address; lines before it are name/company.
  let streetIdx = candidates.findIndex((l) => STREET_LINE.test(l));
  if (streetIdx === -1) {
    // No numeric street found — fall back to original behavior (first line = street).
    streetIdx = 0;
  }

  const street1 = candidates[streetIdx];
  const street2 = candidates.slice(streetIdx + 1).join(", ");

  return { street1, street2, ...cityStateZip };
}

export const ITEM_WEIGHTS_OZ: Record<string, number> = {
  teeShirt: 10,
  sweatshirt: 20,
  jacket: 30,
  hat: 5,
};

const SERVICE_NORMALIZE_MAP: Record<string, string> = {
  usps_ground_advantage: "Ground Advantage",
  groundadvantage: "Ground Advantage",
  usps_priority_mail: "Priority Mail",
  priority: "Priority Mail",
  usps_priority_mail_express: "Priority Mail Express",
  express: "Priority Mail Express",
  usps_media_mail: "Media Mail",
  mediamail: "Media Mail",
  usps_parcel_select: "Parcel Select Ground",
  parcelselect: "Parcel Select Ground",
  usps_first_class_mail: "First Class Mail",
  firstclass: "First Class Mail",
  ups_ground: "UPS Ground",
  ground: "UPS Ground",
  ups_ground_saver: "UPS Ground Saver",
  groundsaver: "UPS Ground Saver",
  ups_3_day_select: "3 Day Select",
  "3dayselect": "3 Day Select",
  ups_2nd_day_air: "2nd Day Air",
  "2nddayair": "2nd Day Air",
  ups_2nd_day_air_am: "2nd Day Air AM",
  "2nddayairam": "2nd Day Air AM",
  ups_next_day_air_saver: "Next Day Air Saver",
  nextdayairsaver: "Next Day Air Saver",
  ups_next_day_air: "Next Day Air",
  nextdayair: "Next Day Air",
  ups_next_day_air_early_am: "Next Day Air Early AM",
  nextdayairearlyam: "Next Day Air Early AM",
};

export function normalizeServiceKey(serviceCode: string): string {
  const lower = serviceCode.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SERVICE_NORMALIZE_MAP[lower] || SERVICE_NORMALIZE_MAP[serviceCode.toLowerCase()] || serviceCode;
}
