import type { CartVendor } from "./poCart";

interface Point {
  lat: number;
  lon: number;
}

/**
 * Approximate straight-line proximity to Concord, NH, using representative
 * city-center coordinates. This is deliberately not a driving/transit estimate.
 *
 * Location mapping sources:
 * - SanMar's canonical warehouse-number list is lib/sanmar/src/types.ts
 *   (SANMAR_WAREHOUSES), whose cities are also returned by vendor-inventory.
 * - S&S's official API docs at https://api.ssactivewear.com/V2/Inventory.aspx
 *   show warehouseAbbr values IL/NJ/KS/NV, and the Products docs show the
 *   expanded set including TX/GA/OH/PA/MA. The official DaysInTransit docs
 *   independently identify IL as Central Time. S&S's Distribution Centers page
 *   publishes the corresponding state/city facilities. These are state-region
 *   abbreviations, not guaranteed facility IDs. IL is therefore represented by
 *   the Chicago/Illinois region (all published Illinois facilities are in that
 *   region), never falsely labeled as one exact facility.
 * - Coordinates are rounded city-center coordinates (US Census geocoder /
 *   Gazetteer), sufficient only for relative great-circle ordering from NH.
 *
 * Unknown/ambiguous codes return null. Callers must then fall back to stock
 * depth rather than manufacturing a distance.
 */

const CONCORD_NH: Point = { lat: 43.2081, lon: -71.5376 };

const SANMAR_BY_CODE: Record<string, Point> = {
  "1": { lat: 47.6062, lon: -122.3321 }, // Seattle, WA
  "2": { lat: 39.1031, lon: -84.5120 }, // Cincinnati, OH
  "3": { lat: 32.7767, lon: -96.7970 }, // Dallas, TX
  "4": { lat: 39.5296, lon: -119.8138 }, // Reno, NV
  "5": { lat: 40.2146, lon: -74.6193 }, // Robbinsville, NJ
  "6": { lat: 30.3322, lon: -81.6557 }, // Jacksonville, FL
  "7": { lat: 44.9778, lon: -93.2650 }, // Minneapolis, MN
  "12": { lat: 33.4484, lon: -112.0740 }, // Phoenix, AZ
  "31": { lat: 37.5407, lon: -77.4360 }, // Richmond, VA
};

const SS_BY_CODE: Record<string, Point> = {
  NJ: { lat: 40.2146, lon: -74.6193 }, // Robbinsville, NJ
  PA: { lat: 40.3356, lon: -75.9269 }, // Reading, PA
  IL: { lat: 41.8781, lon: -87.6298 }, // Illinois/Chicago regional estimate
  MA: { lat: 42.3601, lon: -71.0589 }, // Massachusetts/Boston regional estimate
  OH: { lat: 39.9612, lon: -82.9988 }, // Ohio/Columbus regional estimate
  KS: { lat: 38.8814, lon: -94.8191 }, // Olathe, KS
  GA: { lat: 33.4473, lon: -84.1469 }, // McDonough, GA
  NV: { lat: 39.5296, lon: -119.8138 }, // Reno, NV
  TX: { lat: 32.7555, lon: -97.3308 }, // Fort Worth, TX
};

const SANMAR_NAME_BY_CODE: Record<string, string> = {
  "1": "Seattle, WA",
  "2": "Cincinnati, OH",
  "3": "Dallas, TX",
  "4": "Reno, NV",
  "5": "Robbinsville, NJ",
  "6": "Jacksonville, FL",
  "7": "Minneapolis, MN",
  "12": "Phoenix, AZ",
  "31": "Richmond, VA",
};

const SS_NAME_BY_CODE: Record<string, string> = {
  NJ: "Robbinsville, NJ",
  PA: "Reading, PA",
  IL: "Illinois / Chicago region",
  MA: "Massachusetts / Boston region",
  OH: "Ohio / Columbus region",
  KS: "Olathe, KS",
  GA: "McDonough, GA",
  NV: "Reno, NV",
  TX: "Fort Worth, TX",
};

function radians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function greatCircleMiles(a: Point, b: Point): number {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

export function warehouseDistanceFromConcord(
  vendor: CartVendor | null,
  code: string,
): number | null {
  const point =
    vendor === "sanmar"
      ? SANMAR_BY_CODE[code]
      : vendor === "ss"
        ? SS_BY_CODE[code.trim().toUpperCase()]
        : undefined;
  return point ? greatCircleMiles(CONCORD_NH, point) : null;
}

export function warehouseGeographicName(
  vendor: CartVendor | null,
  code: string,
  fallback: string,
): string {
  return (
    (vendor === "sanmar"
      ? SANMAR_NAME_BY_CODE[code]
      : vendor === "ss"
        ? SS_NAME_BY_CODE[code.trim().toUpperCase()]
        : undefined) ?? fallback
  );
}

/** Known proximity wins before stock; unknown/ambiguous pairs defer to stock. */
export function compareWarehousePreference(
  vendor: CartVendor | null,
  a: { code: string; totalQty: number },
  b: { code: string; totalQty: number },
): number {
  const aDistance = warehouseDistanceFromConcord(vendor, a.code);
  const bDistance = warehouseDistanceFromConcord(vendor, b.code);
  if (aDistance !== null && bDistance !== null && aDistance !== bDistance) {
    return aDistance - bDistance;
  }
  return b.totalQty - a.totalQty;
}

/**
 * Avoid a partly-known candidate set producing a misleading or non-transitive
 * ordering: proximity is used only when every candidate location is known.
 */
export function sortWarehousePreference<T extends { code: string; totalQty: number }>(
  vendor: CartVendor | null,
  options: T[],
): T[] {
  const allKnown = options.every(
    (option) => warehouseDistanceFromConcord(vendor, option.code) !== null,
  );
  return [...options].sort(
    allKnown
      ? (a, b) => compareWarehousePreference(vendor, a, b)
      : (a, b) => b.totalQty - a.totalQty,
  );
}