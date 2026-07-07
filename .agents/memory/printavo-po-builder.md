---
name: PO Builder — Needs Ordering scan, PO generation, Printavo write mutations
description: Two-pass scan for need_ordering line items, PO cart→HTML→po_files flow, productionFileCreate push, status mutations, SanMar ProductInfo pricing fields (differs from Breezy)
---

# What it does
Scans all Printavo invoices for line items with productStatus `need_ordering`, staff build a combined PO cart across orders, pick vendor (SanMar/S&S), optionally pull live SanMar cost, generate HTML PO → saved in `po_files` table → optionally pushed back to Printavo as a production file on each related invoice.

# Two-pass scan (proven, ~90s full crawl)
- Pass 1 slim: `invoices(first:25, sortOn: VISUAL_ID, sortDescending:true)` fetching only lineItem `id + productStatus`; ~330ms/page; nesting `lineItemGroups(first:5){lineItems(first:8)}` per 25 invoices stays under 25k complexity — do NOT raise these.
- Pass 2: `invoice(id:)` full fetch only for matched IDs, parallel batches of 5.
- MAX_PAGES=50 (1,250 invoices), PAGE_DELAY_MS=1500 (429s below that), retry after 8s on 429.
- NO early termination — need_ordering items observed at pages 3, 11, 34; orders >90 days old can still need ordering.
- Cache: in-memory 25-min TTL; background refresh every 20 min (silent — partial result stays null so users see cached data); user `?refresh=true` clears cache w/ 2s polling progress.

# CONFIRMED Printavo v2 API limitations (via introspection in this repo)
- Invoice type has NO `updatedAt` FIELD; `invoices` sortOn enum = CUSTOMER_DUE_AT, CUSTOMER_NAME, STATUS, OWNER, TOTAL, VISUAL_ID only (no UPDATED_AT sort).
- NOTE: this does not contradict the sync-engine finding that an `updatedAfter` filter argument may exist on some queries — but this repo could not sort/read updatedAt. Hub sync design must re-verify `updatedAfter` behavior before relying on it.
- Valid Invoice timestamps: createdAt, dueAt, customerDueAt.
- lineItem fields used: id, itemNumber, description, items (qty), price, productStatus (enum e.g. need_ordering/ordered), color, product{id, brand}, sizes{id, size, count}. Size names normalized: strip `size_` prefix, uppercase.

# Write mutations (proven working)
- Line item status: must first query `lineItem(id){position}` then `lineItemUpdate(id, input:{productStatus, position})` — position is REQUIRED in the input or the mutation fails.
- Order status: `statusUpdate(parentId: invoiceId, statusId)`.
- Push PO: `productionFileCreate(parentId: invoiceId, publicFileUrl)` — the PO HTML is stored in DB and served at a PUBLIC unauthenticated URL (`/api/po-file/:id`); Printavo fetches from that URL. Gotcha: repo uses REPLIT_DEV_DOMAIN for the public URL — in Hub use the deployed domain.
- Statuses list: `statuses(first:100){id,name}`.

# Status label conventions (this account)
- Order status names carry agency prefix `"Seps.io - "` — strip up to first " - " before comparing.
- 6 hardcoded "Need 2 Order" pill labels incl. VENDOR SPECIAL PRICING / RUSH / ADD ON / PARTIAL IN-HOUSE / STOCK ISSUE variants (emoji-prefixed); anything else shows as dynamic "Other" pill.

# SanMar pricing — DIFFERENT approach from Breezy (reconcile in Hub!)
- PO Builder uses ONLY ProductInfoService (getProductInfoByStyleColorSize with style+color): `pieceSalePrice`/`dozenSalePrice` = account net cost (USE), `piecePrice`/`dozenPrice` = MSRP (do NOT use as cost).
- Breezy uses ProductInfo piecePrice as catalog + separate PricingService casePrice as regular dealer net.
- Env names also differ: PO Builder = SANMAR_CUSTOMER/SANMAR_USER/SANMAR_PASS; Breezy = SANMAR_ACCOUNT_NUMBER/SANMAR_USERNAME/SANMAR_PASSWORD. Hub should standardize one set + one SanMar client.
- S&S pricing here is BLOCKED (Cloudflare 503 on their API from this app) — but Breezy's S&S client works; use Breezy's.

# DB
`po_files`: id uuid PK, po_number, vendor_name, notes, total_quantity, total_cost numeric, line_items jsonb (SelectedLineItem[] snapshot), html_content text, created_at. PO log page supports edit of metadata + reprint + re-push.

# Hub notes
- Same pnpm monorepo template as Hub workspace; REST layer ports easily.
- Scan cache is per-process in-memory — in Hub, back it with the shared Printavo DB sync instead of re-crawling (sync engine already fetches productStatus).
- Secrets: PRINTAVO_EMAIL, PRINTAVO_TOKEN (headers `email`/`token`, not Bearer), SanMar trio, DATABASE_URL.
