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

export function parseBlockAddress(
  text: string
): { street1: string; street2: string; city: string; state: string; postalCode: string } | null {
  const lines = text.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const cityStateLine = lines[lines.length - 1];

  const csMatch = cityStateLine.match(/^(.+?),\s*([A-Za-z\s]+?)\s+(\d{5}(?:-\d{4})?)$/);
  if (!csMatch) return null;

  const rawCity = csMatch[1].trim();
  const rawState = csMatch[2].trim();
  const postalCode = csMatch[3].trim();

  const stateCode = STATE_NAME_TO_CODE[rawState.toLowerCase()];
  if (!stateCode) return null;

  const addressLines = lines.slice(0, -1);
  const street1 = addressLines[0] || "";
  const street2 = addressLines.length > 1 ? addressLines.slice(1).join(", ") : "";

  return { street1, street2, city: rawCity, state: stateCode, postalCode };
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
