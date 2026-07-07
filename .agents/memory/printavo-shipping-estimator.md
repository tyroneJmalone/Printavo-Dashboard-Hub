---
name: Shipping Rate Estimator — ShipStation + EasyPost rate comparison
description: Dual-source USPS/UPS rate quoting, weight calculator constants, preset boxes, ship-from address; no Printavo integration; older single-app template
---

# What it does
Internal rate-quoting tool: staff enter destination + package, get side-by-side USPS/UPS rates from TWO sources (ShipStation vs EasyPost) with price diff and transit time. Stateless — no DB, no auth, no Printavo, no label purchase.

# NOT the monorepo template
Older client/server/shared single-app layout (Express + Vite, wouter, zod in shared/schema.ts) — needs restructuring to port into Hub, unlike Breezy/PO Builder/Mint Bucks.

# ShipStation client (REST v1)
- `POST https://ssapi.shipstation.com/shipments/getrates`, Basic auth base64(SHIPSTATION_API_KEY:SHIPSTATION_API_SECRET), 10s AbortController timeout.
- Two carrier codes queried in parallel: `stamps_com` (USPS) and `ups_walleted` (UPS via ShipStation's reseller account — NOT the shop's own UPS discounts).
- Weight sent in OUNCES (pounds × 16). totalCost = shipmentCost + otherCost. transitDays unreliable.
- `GET /carriers` used for diagnostics.

# EasyPost client
- `@easypost/api` npm pkg, EASYPOST_API_KEY. `client.Shipment.create({from_address,to_address,parcel})` → shipment.rates (quote only; `Shipment.buy()` for labels NOT implemented yet).
- Weight in ounces. Carrier grouping: USPS/USPSRETURNSERVICE → USPS; UPS/UPSDAP/UPSMAILINNOVATIONS → UPS.
- UPS rates HERE reflect the shop's OWN negotiated discounts (UPS account linked in EasyPost dashboard) — this is the more accurate UPS source; ShipStation UPS is reseller pricing.
- delivery_days reliably returned (use EasyPost transit first, ShipStation fallback; UPS Ground Saver defaults to "Ground +1 day" when both missing).

# Business constants (hardcoded — keep in Hub)
- Ship-from: Mint Printworks, 125 Northeastern Blvd, Nashua NH 03062.
- Weight calculator: Tee 10 oz, Sweatshirt 20 oz, Jacket 30 oz, Hat 5 oz; total rounded UP to nearest pound.
- Preset boxes: 4 USPS flat-rate, 3 UPS Express, 3 standard (16×12×8 / 18×12×12 / 24×16×12) + custom.
- Requests always residential:true, confirmation:"none".
- Quick Paste address parser in UI (full address block → fields, handles full state names).

# Hub integration ideas (from its own context doc)
Pre-fill ship-to from Printavo order; auto-fill weight calc from order line items (garment types map to oz constants); write chosen rate back to order; add EasyPost Shipment.buy() label purchase tied to Printavo order.

# Env
SHIPSTATION_API_KEY, SHIPSTATION_API_SECRET, EASYPOST_API_KEY. In-memory 20 req/min/IP limit.
