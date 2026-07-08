---
name: Hub reports UI semantics
description: Display contracts between the reports API and any frontend consuming it
---

- `pctOfRevenue` in breakdown rows is ALREADY a 0-100 percentage (backend rounds to 1 decimal). Never multiply by 100 in the UI; clamp bar widths to 100.
- Date-only fields (e.g. `invoiceAt` as `YYYY-MM-DD`) must be parsed manually into local date parts. `new Date("YYYY-MM-DD")` treats it as UTC midnight and shifts the displayed day in US timezones.
- Money is always displayed with exactly 2 decimals (Intl USD, `minimumFractionDigits: 2`); backend sends raw numbers like 581.8.
- **Why:** All three caused visible display bugs (4250%, off-by-one dates, $581.8) in the first Reports UI build.
- **How to apply:** Any new Hub module or portal page rendering report data must reuse `formatMoney`/`formatDate` from the hub `lib/format.ts` pattern rather than ad-hoc formatting.

- Filter param contract: multiselects join with `||`; exclude keys also `||`-joined and must match backend EXCLUDABLE_FILTERS; every filter change must reset pagination offset to page 0 (including the date-basis select).
