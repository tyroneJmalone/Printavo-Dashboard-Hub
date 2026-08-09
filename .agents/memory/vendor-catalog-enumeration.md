---
name: Vendor catalog enumeration & import
description: How to enumerate full SanMar and S&S catalogs, throttling behavior, and invariants of the local catalog import.
---

# Full-catalog enumeration

- **S&S**: `GET /v2/styles/` returns the ENTIRE catalog in one call. Image fields are relative paths (prefix `https://www.ssactivewear.com/`). Colors/prices still need per-style products calls.
- **S&S throttling**: bursts of per-style calls get HTTP 503/429 (even the styles listing after repeated attempts). Exponential-backoff retry is mandatory; modest concurrency (~5) with backoff works.
- **SanMar**: PromoStandards ProductData `getProductSellable` — the live service is **wsVersion 1.0.0** (not 2.0.0), and ALL request elements (`wsVersion`, `id`, `password`, `isSellable`) go in the **SharedObjects namespace**; the request element itself in the main service ns. Large multi-MB response; needs a ~3 min timeout. Read-only, safe to call.

# Local catalog invariants

**Why:** staff corrections must survive nightly re-imports, and long imports must survive restarts.
- Staff input never lives on imported rows: color-family fixes keyed by normalized color name (`source='staff'` wins; AI pass never overwrites), product tag fixes keyed (vendor, style_name). The tag-override endpoint merges DELTAS with stored state — replacing wholesale wipes earlier corrections (review-caught bug).
- Importers skip styles seen very recently, so interrupted seeds resume across restarts.
- Discontinued flagging keys on the ENUMERATION list, never per-style fetch success, and is skipped when too many fetches fail — vendor flakiness must not mass-flag the catalog.
- Live inventory is deliberately never cached; search links through to the live-stock lookup.
- AI tagging happens only at import; search is deterministic tokenized SQL with color-family expansion.
