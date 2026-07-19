import { Router, type IRouter } from "express";
import { ShippingGetRatesBody } from "@workspace/api-zod";
import EasyPostApi from "@easypost/api";

const router: IRouter = Router();

const SHIPSTATION_API_BASE = "https://ssapi.shipstation.com";

// Mint Printworks ship-from address (source: shipstimator shared/schema.ts)
const shipFromAddress = {
  name: "Mint Printworks",
  street1: "125 Northeastern Blvd",
  city: "Nashua",
  state: "NH",
  postalCode: "03062",
  country: "US",
};

interface ShippingRate {
  carrierCode: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  shipmentCost: number;
  otherCost: number;
  totalCost: number;
  transitDays: number | null;
  deliveryDate: string | null;
  source: "shipstation" | "easypost";
}

interface SourceRates {
  uspsRates: ShippingRate[];
  upsRates: ShippingRate[];
  errors: string[];
}

interface RateResponse {
  shipstation?: SourceRates;
  easypost?: SourceRates;
}

function getAuthHeader(): string {
  const key = process.env.SHIPSTATION_API_KEY;
  const secret = process.env.SHIPSTATION_API_SECRET;
  if (!key || !secret) {
    throw new Error("ShipStation API credentials not configured");
  }
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

function getEasyPostClient(): InstanceType<typeof EasyPostApi> {
  const key = process.env.EASYPOST_API_KEY;
  if (!key) {
    throw new Error("EasyPost API key not configured");
  }
  return new EasyPostApi(key);
}

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 20;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

async function fetchShipStationCarrierRates(
  carrierCode: string,
  fromPostalCode: string,
  toState: string,
  toCountry: string,
  toPostalCode: string,
  toCity: string,
  weight: { value: number; units: string },
  dimensions: { length: number; width: number; height: number; units: string }
): Promise<ShippingRate[]> {
  const body = {
    carrierCode,
    fromPostalCode,
    toState,
    toCountry,
    toPostalCode,
    toCity,
    weight,
    dimensions,
    confirmation: "none",
    residential: true,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${SHIPSTATION_API_BASE}/shipments/getrates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: getAuthHeader(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`ShipStation rate error for ${carrierCode}:`, errorText);
      throw new Error(`Failed to get ${carrierCode} rates: ${response.status}`);
    }

    const data = (await response.json()) as any[];

    return data.map((rate: any) => ({
      carrierCode: carrierCode,
      carrierName: carrierCode === "stamps_com" ? "USPS" : "UPS",
      serviceCode: rate.serviceCode || "",
      serviceName: rate.serviceName || "",
      shipmentCost: rate.shipmentCost || 0,
      otherCost: rate.otherCost || 0,
      totalCost: (rate.shipmentCost || 0) + (rate.otherCost || 0),
      transitDays: rate.transitDays ?? null,
      deliveryDate: rate.deliveryDate ?? null,
      source: "shipstation" as const,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchShipStationRates(
  shipTo: { street1: string; city: string; state: string; postalCode: string; country: string },
  pkg: { length: number; width: number; height: number; weight: number; weightUnit: string }
): Promise<SourceRates> {
  const weightInOz = pkg.weightUnit === "pounds" ? pkg.weight * 16 : pkg.weight;
  const weight = { value: weightInOz, units: "ounces" as const };
  const dimensions = { length: pkg.length, width: pkg.width, height: pkg.height, units: "inches" as const };

  const errors: string[] = [];
  let uspsRates: ShippingRate[] = [];
  let upsRates: ShippingRate[] = [];

  const [uspsResult, upsResult] = await Promise.allSettled([
    fetchShipStationCarrierRates("stamps_com", shipFromAddress.postalCode, shipTo.state, shipTo.country || "US", shipTo.postalCode, shipTo.city, weight, dimensions),
    fetchShipStationCarrierRates("ups_walleted", shipFromAddress.postalCode, shipTo.state, shipTo.country || "US", shipTo.postalCode, shipTo.city, weight, dimensions),
  ]);

  if (uspsResult.status === "fulfilled") {
    uspsRates = uspsResult.value;
  } else {
    errors.push(`USPS: ${uspsResult.reason?.message || "Unknown error"}`);
  }

  if (upsResult.status === "fulfilled") {
    upsRates = upsResult.value;
  } else {
    errors.push(`UPS: ${upsResult.reason?.message || "Unknown error"}`);
  }

  return {
    uspsRates: uspsRates.sort((a, b) => a.totalCost - b.totalCost),
    upsRates: upsRates.sort((a, b) => a.totalCost - b.totalCost),
    errors,
  };
}

async function fetchEasyPostRates(
  shipTo: { street1: string; street2?: string; city: string; state: string; postalCode: string; country: string },
  pkg: { length: number; width: number; height: number; weight: number; weightUnit: string }
): Promise<SourceRates> {
  const weightInOz = pkg.weightUnit === "pounds" ? pkg.weight * 16 : pkg.weight;

  try {
    const client = getEasyPostClient();
    const shipment = await client.Shipment.create({
      from_address: {
        name: shipFromAddress.name,
        street1: shipFromAddress.street1,
        city: shipFromAddress.city,
        state: shipFromAddress.state,
        zip: shipFromAddress.postalCode,
        country: shipFromAddress.country,
      },
      to_address: {
        street1: shipTo.street1,
        street2: shipTo.street2 || "",
        city: shipTo.city,
        state: shipTo.state,
        zip: shipTo.postalCode,
        country: shipTo.country || "US",
      },
      parcel: {
        length: pkg.length,
        width: pkg.width,
        height: pkg.height,
        weight: weightInOz,
      },
    });

    const uspsRates: ShippingRate[] = [];
    const upsRates: ShippingRate[] = [];
    const errors: string[] = [];

    if (shipment.rates) {
      for (const rate of shipment.rates) {
        const carrierUpper = (rate.carrier || "").toUpperCase();
        const isUSPS = carrierUpper === "USPS" || carrierUpper === "USPSRETURNSERVICE";
        const isUPS = carrierUpper === "UPS" || carrierUpper === "UPSDAP" || carrierUpper === "UPSMAILINNOVATIONS";

        const mapped: ShippingRate = {
          carrierCode: rate.carrier || "",
          carrierName: isUSPS ? "USPS" : isUPS ? "UPS" : rate.carrier || "Other",
          serviceCode: rate.service || "",
          serviceName: rate.service ? rate.service.replace(/([A-Z])/g, " $1").replace(/^\s/, "").replace(/\s+/g, " ") : "",
          shipmentCost: parseFloat(rate.rate || "0"),
          otherCost: 0,
          totalCost: parseFloat(rate.rate || "0"),
          transitDays: rate.delivery_days ?? null,
          deliveryDate: rate.delivery_date ?? null,
          source: "easypost" as const,
        };

        if (isUSPS) {
          uspsRates.push(mapped);
        } else if (isUPS) {
          upsRates.push(mapped);
        }
      }
    }

    return {
      uspsRates: uspsRates.sort((a, b) => a.totalCost - b.totalCost),
      upsRates: upsRates.sort((a, b) => a.totalCost - b.totalCost),
      errors,
    };
  } catch (error: any) {
    console.error("EasyPost rate error:", error);
    return {
      uspsRates: [],
      upsRates: [],
      errors: [`EasyPost: ${error.message || "Unknown error"}`],
    };
  }
}

router.get("/shipping/carriers", async (_req, res) => {
  try {
    const response = await fetch(`${SHIPSTATION_API_BASE}/carriers`, {
      headers: { Authorization: getAuthHeader() },
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch carriers" });
    }
    const carriers = await response.json();
    return res.json(carriers);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/shipping/rates", async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
  }

  try {
    const parsed = ShippingGetRatesBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request",
        details: parsed.error.issues,
      });
    }

    const { shipTo, package: pkg, source } = parsed.data;
    const response: RateResponse = {};

    const promises: Promise<void>[] = [];

    if (source === "shipstation" || source === "both") {
      promises.push(
        fetchShipStationRates(shipTo, pkg).then((rates) => {
          response.shipstation = rates;
        })
      );
    }

    if (source === "easypost" || source === "both") {
      promises.push(
        fetchEasyPostRates(shipTo, pkg).then((rates) => {
          response.easypost = rates;
        })
      );
    }

    await Promise.all(promises);

    return res.json(response);
  } catch (error: any) {
    console.error("Rate estimation error:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch rates" });
  }
});

export default router;
