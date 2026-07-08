---
name: Vendor Order Hub — SanMar/S&S PO submission & tracking
description: Vendor order submission (SanMar SOAP submitPO, S&S REST orders), PO browse via invoices+quotes traversal, PDF PO parser, DB-stored credentials (plaintext), overlap with PO Builder; modern monorepo template
---

# What it does
Submits purchase orders to vendors and tracks them: import PO from Printavo (browse unordered POs or enter visual PO #), or upload a vendor PDF, or manual entry → per-line vendor pick (SanMar/S&S/Skip) with live inventory + warehouse selection → submit via vendor API → dashboard tracks status/tracking with refresh + archive.

# User-stated status (July 2026)
- S&S order SUBMISSION is UNTESTED in production.
- Printavo PO import "still needs work".
- Built AFTER PO Builder; they overlap (same process) but don't work hand-in-hand. User wants them combined into ONE interface in the Hub.

# MODERN monorepo template ✅ (near-verbatim port like Breezy/PO Builder/Mint Bucks/PDF Sorter)

# DB schema (tables prefixed sanmar_ even for S&S)
- sanmar_orders: vendorId ("sanmar"|"ss", default sanmar for legacy rows), poNumber, shipMethod (default GROUND), status (pending/submitted/error), sanmarOrderNumber (also holds S&S order #s joined "1234, 5678" — S&S can split across warehouses), shippingAddress jsonb, sanmarStatus, trackingNumbers jsonb, archived+archiveNote.
- sanmar_line_items: styleNumber, colorName, warehouseId, pricing jsonb, sizeQuantities jsonb [{size, quantity}].
- Credentials in DB tables NOT env vars: sanmar_settings, ss_settings, printavo_settings.

# ⚠️ Security: password_encrypted column is PLAINTEXT
Column named passwordEncrypted but value used directly as the SOAP password — no crypto anywhere. Hub must move all vendor + Printavo creds to Replit secrets (also resolves the SanMar env-var naming conflict noted in po-builder/breezy files).

# SanMar order submission (SOAP — THE missing piece other apps lack)
- Endpoint: https://ws.sanmar.com:8080/SanMarWebService/SanMarPOServicePort, op `submitPO` (ns http://webservice.integration.sanmar.com/).
- One <webServicePoDetailList> entry PER SIZE: style, color, size, optional sizeIndex + inventoryKey, quantity, whseNo (int).
- Ship method map: GROUND→"UPS", 2DAY→"UPS 2ND DAY", OVERNIGHT→"UPS NEXT DAY", also PSST/TRUCK/USPS PP/etc.
- Status refresh via separate GetOrderStatus service (sanmar-status.ts); 9 warehouses (Seattle, Cincinnati, Dallas, Reno, Robbinsville, Jacksonville, Minneapolis, Phoenix, Richmond).

# S&S order submission (REST — untested!)
- POST https://api.ssactivewear.com/v2/orders/, Basic auth base64(accountNumber:apiKey).
- Body: {shippingAddress{customer,attn,address,city,state,zip,residential}, shippingMethod ("1" ground/"2" next day/"3" 2nd day), poNumber, autoselectWarehouse:false, rejectLineErrors:false, lines:[{warehouseAbbr,identifier(SKU),qty}]}.
- Response is ARRAY of orders (split across warehouses); status via GET /v2/orders/{n}?lines=true&Boxes=true, tracking from order.boxes[].trackingNumber.
- 17 warehouse abbrs: IL NV GA KS TX FL OH PA DS CC CN FO GD KC MA PH TD.

# Printavo PO browse (compare with PO Builder's two-pass scan)
- No root purchaseOrders query; traverse invoices AND quotes → lineItemGroups(first:8) → lineItems(first:15) → poLineItem → purchaseOrder. 8 pages × 25 each, complexity ≈24k (limit 25k). Shared seen-Set dedup by PO id; detail via root lineItem(id) query (no nesting cost).
- Filter goodsStatus === "not_ordered" OR null.
- Quirks: PurchaseOrder.vendor{name} declared Vendor! but returns null → GraphQL error if requested, OMIT IT. Invoice.visualPoNumber always empty on this account. REST v1 /purchase_orders → 404. POs beyond 8th group/15th item are unreachable.
- visualPoId = user-visible PO number.

# PDF PO parser
POST /api/parse-po, pdf-parse with pagerender hook for coordinate-based text items → extracts style/color/sizes/qty from vendor PDFs.

# Hub consolidation notes
- Merge with PO Builder into one ordering interface (user request): PO Builder's need_ordering scan + line-item mutations + productionFileCreate, plus this app's actual vendor submission + status/tracking.
- Third distinct SanMar client in the fleet: Breezy (PricingService), PO Builder (ProductInfo), this (PO submitPO + inventory). Hub should unify into one SanMar module with all three services.
- drizzle-kit push (no migration files) — same pattern as other monorepo apps.

## need_ordering data-quality quirks (seen in live data, July 2026)
- The need_ordering flag can be stale: orders already in "PICKED UP" status (e.g. items=0 lines) may still carry it. Cart building must filter items<=0 or surface a "stale flag" warning — never auto-add to vendor carts.
- Line item `sizes` counts may not sum to `items`. For per-size vendor submission, `sizes` (count>0) is the source of truth, not `items`.
