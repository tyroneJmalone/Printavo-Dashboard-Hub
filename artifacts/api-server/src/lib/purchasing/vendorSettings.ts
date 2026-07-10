import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Vendor order settings — the ship-to address SanMar/S&S orders are shipped
 * to, plus the default carrier speed. Stored as a single app_settings row so
 * Tyler can edit it from the UI (P4b) without a code change.
 */

const SHIP_TO_KEY = "vendor_ship_to";

export type ShipMethodCode = "GROUND" | "2DAY" | "OVERNIGHT";

export interface VendorShipTo {
  /** Company / ship-to name (SanMar shipTo, S&S customer). */
  companyName: string;
  attention: string | null;
  address1: string;
  address2: string | null;
  city: string;
  /** 2-letter state code. */
  state: string;
  /** 5- or 9-digit ZIP. */
  zip: string;
  email: string | null;
  residential: boolean;
  defaultShipMethod: ShipMethodCode;
}

export async function getVendorShipTo(): Promise<VendorShipTo | null> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, SHIP_TO_KEY))
    .limit(1);
  return rows[0] ? (rows[0].value as VendorShipTo) : null;
}

export async function setVendorShipTo(value: VendorShipTo): Promise<VendorShipTo> {
  await db
    .insert(appSettingsTable)
    .values({ key: SHIP_TO_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
  return value;
}
