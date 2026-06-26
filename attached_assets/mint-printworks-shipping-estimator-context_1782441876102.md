# Mint Printworks — Shipping Rate Estimator: Agent Context Doc

## Purpose
This is a standalone internal tool for **Mint Printworks** (a tee shirt & hat print shop) that fetches real-time USPS and UPS shipping rate quotes. Staff enter a destination address and package details, and the app returns a side-by-side comparison of rates from two sources: ShipStation and EasyPost. It is not customer-facing.

**No Printavo integration currently exists in this app.** It operates independently but is intended to eventually be part of a broader Mint Printworks dashboard that connects to the same Printavo account used across their other tools.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TailwindCSS + shadcn/ui |
| Backend | Express.js (Node/TypeScript) |
| Shared types | Zod schemas in `shared/schema.ts` |
| Routing | Wouter (client-side) |
| Data fetching | TanStack Query v5 |
| Deployment | Replit Autoscale (`npm run build` → `node ./dist/index.cjs`) |

---

## Ship-From Address (hardcoded)
```
Mint Printworks
125 Northeastern Blvd
Nashua, NH 03062
```
This is defined in `shared/schema.ts` as `shipFromAddress` and used by both API integrations on every rate request.

---

## API Integrations

### 1. ShipStation API v1
- **Base URL:** `https://ssapi.shipstation.com`
- **Auth:** HTTP Basic — base64(`SHIPSTATION_API_KEY:SHIPSTATION_API_SECRET`)
- **Endpoint used:** `POST /shipments/getrates`
- **Carriers queried:**
  - `stamps_com` → USPS rates
  - `ups_walleted` → UPS rates (ShipStation's walleted/reseller UPS account — not Mint Printworks' own UPS account)
- **Timeout:** 10 seconds (AbortController)
- **Notes:** Transit days are inconsistently returned. `otherCost` is included in `totalCost`. Rates are ShipStation's negotiated pricing, not necessarily Mint Printworks' own carrier discounts.

### 2. EasyPost API
- **Package:** `@easypost/api` npm package
- **Auth:** `EASYPOST_API_KEY` environment variable
- **Method:** `client.Shipment.create({ from_address, to_address, parcel })` → reads `shipment.rates`
- **Carriers returned:** USPS and UPS (UPS only returns if a UPS account is linked in the EasyPost dashboard — this has been done for Mint Printworks)
- **Notes:** Returns the rates associated with Mint Printworks' linked carrier accounts, so UPS rates reflect their actual negotiated discounts. Transit days (`delivery_days`) are reliably returned for most services.

---

## API Endpoints (Backend)

### `POST /api/rates`
Fetches rates from both ShipStation and EasyPost simultaneously.

**Request body:**
```json
{
  "shipTo": {
    "street1": "123 Main St",
    "street2": "Apt 4B",
    "city": "Portland",
    "state": "ME",
    "postalCode": "04101",
    "country": "US"
  },
  "package": {
    "presetId": "std_small",
    "length": 16,
    "width": 12,
    "height": 8,
    "weight": 5,
    "weightUnit": "pounds"
  },
  "source": "both"
}
```

**Response shape:**
```json
{
  "shipstation": {
    "uspsRates": [ ...ShippingRate ],
    "upsRates": [ ...ShippingRate ],
    "errors": []
  },
  "easypost": {
    "uspsRates": [ ...ShippingRate ],
    "upsRates": [ ...ShippingRate ],
    "errors": []
  }
}
```

**ShippingRate object:**
```ts
{
  carrierCode: string,
  carrierName: string,       // "USPS" or "UPS"
  serviceCode: string,       // e.g. "usps_ground_advantage", "Ground"
  serviceName: string,       // human-readable
  shipmentCost: number,
  otherCost: number,
  totalCost: number,
  transitDays: number | null,
  deliveryDate: string | null,
  source: "shipstation" | "easypost"
}
```

### `GET /api/carriers`
Returns the list of carriers configured in ShipStation. Used for diagnostics.

### Rate limiting
20 requests per minute per IP address (in-memory, resets on restart).

---

## Weight Handling
- Weight is always submitted in **pounds** to the APIs.
- EasyPost internally requires ounces — the backend converts: `weightInOz = weight * 16` before calling `Shipment.create`.
- The UI has a **Weight Calculator** that lets staff enter item quantities (Tee Shirt, Sweatshirt, Jacket, Hat). It tallies the ounce total and converts to pounds, **rounded up to the nearest pound**, before filling the weight field.

**Item weights used in the calculator:**
| Item | Weight |
|---|---|
| Tee Shirt | 10 oz |
| Sweatshirt | 20 oz |
| Jacket | 30 oz |
| Hat | 5 oz |

---

## Preset Box Dimensions

| Preset | Dimensions (L × W × H inches) |
|---|---|
| USPS Small Flat Rate Box | 8.625 × 5.375 × 1.625 |
| USPS Medium Flat Rate Box (Top Loading) | 11.25 × 8.75 × 6 |
| USPS Medium Flat Rate Box (Side Loading) | 14 × 12 × 3.5 |
| USPS Large Flat Rate Box | 12.25 × 12.25 × 6 |
| UPS Express Box - Small | 13 × 11 × 2 |
| UPS Express Box - Medium | 16 × 11 × 3 |
| UPS Express Box - Large | 18 × 13 × 3 |
| Small Standard | 16 × 12 × 8 |
| Medium Standard | 18 × 12 × 12 |
| Large Standard | 24 × 16 × 12 |
| Custom Dimensions | user-entered |

---

## UI Features

- **Ship To Address card** — manual field entry or "Quick Paste" mode (paste a full address block, auto-parsed into fields; supports full state names and 2-letter codes)
- **Package Details card** — box type preset selector + custom dimension fields + weight input (always in lbs)
- **Weight Calculator card** — item quantity inputs that auto-calculate and fill the weight field
- **Results** — always shown as a **Comparison Table** (ShipStation vs EasyPost, side by side per service). Shows price, price difference (absolute + %), and transit time per service. Transit time is sourced from EasyPost first, ShipStation as fallback. UPS Ground Saver defaults to "Ground +1 day" when neither API returns transit data.

---

## Environment Variables Required

| Variable | Purpose |
|---|---|
| `SHIPSTATION_API_KEY` | ShipStation API key |
| `SHIPSTATION_API_SECRET` | ShipStation API secret |
| `EASYPOST_API_KEY` | EasyPost API key |

---

## What This App Does NOT Do
- No Printavo integration
- No order creation or management
- No label generation (EasyPost supports `Shipment.buy()` for label purchase — not yet implemented)
- No persistent data storage or usage logging
- No authentication/access control (internal tool only)
- No customer-facing interface

---

## Integration Opportunities for a Combined Dashboard

If merging this into a broader Mint Printworks dashboard that connects to Printavo, natural integration points would be:

1. **Pull ship-to address from a Printavo order** — pre-fill the destination address from an open order, eliminating manual entry
2. **Pull order item quantities from Printavo** — auto-populate the weight calculator based on what's in the order (shirts, hats, etc.)
3. **Write selected shipping rate back to Printavo** — once staff choose a rate, stamp it on the order record
4. **Label generation** — after selecting a rate from the comparison table, use EasyPost's `Shipment.buy()` to purchase and generate a label tied to the Printavo order
