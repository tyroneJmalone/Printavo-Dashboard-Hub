# Printavo Hub — Status & Roadmap Review

_Updated Aug 7, 2026. A living snapshot for choosing next steps. Detailed reasoning behind each idea lives in `docs/insights-log.md`._

---

## 1. What's built and live

| Module | Status |
|---|---|
| Printavo sync engine (5-min incremental + daily deep crawl, 12-mo window + frozen historical archive) | ✅ Live |
| Full backup (all entities, file mirroring, one-click ZIP export) | ✅ Live |
| Reports / Payments / Analyze | ✅ Live (backend done; more preset reports planned) |
| Vendor Orders / Purchasing (needs-ordering scan → PO cart → electronic SanMar & S&S submission → tracking) | ✅ Live, verified end-to-end |
| Status Rules engine (suggestion-only) | ✅ Live |
| Print Queue + Queue Rules + Auto-Print (PrintNode) | ✅ Live (PQ3b packing slips/box labels remaining) |
| Price Calculator (Breezy port) | ✅ Live |
| moMINTum tasks (shared live DB with standalone app) | ✅ Live |
| Printavo ⇄ moMINTum task sync | ✅ Built (poller dormant until flag flipped) |
| Mint Bucks (full port, shared live DB) | ✅ Live (emails still in test mode — all route to Tyler) |
| Ask AI insights (guarded read-only LLM→SQL) | ✅ Live |
| Chipply web stores (CH1) | ✅ Live (CH2 confirmed as next Chipply step) |
| Shipping: Rate Estimator + Label Sorter | ✅ Live |
| Pipeline, Customer Directory, Niche Report, Customer Profiles | ✅ Live |
| Global Printavo sync bar (status + Sync now on every page) | ✅ Live (Aug 7) |

## 2. Drafted & awaiting your acceptance (tasks panel)

**Product Curation Tool** — three phases, each building on the last:

1. **Task #5 — Product Finder: cross-vendor stock checker.** Style search across SanMar + S&S at once, color pick, size × warehouse live inventory grid, cross-vendor style aliasing, multi-select, invoice line-item stock check. Mostly UI — vendor lookups already exist under the PO builder.
2. **Task #6 — Descriptive search & color families.** Local product catalog of both vendors with nightly automated refresh (prices/colors/styles; staff tag corrections survive; health panel). AI tags color families + garment attributes at import time; "forest green polos" style searches run instantly against tags. Inventory deliberately never cached — always live.
3. **Task #7 — Collections & customer curation.** Star/save styles to named collections, link to customers (visible on customer profile), fresh stock re-checks, send-to-Price-Calculator. Sell sheets + push-to-invoice flagged as future follow-ons.

## 3. Ideas backlog (assessed, not yet planned)

| Idea | Feasibility | Key dependency / note |
|---|---|---|
| **In-house inventory flags in Purchasing / PO Queue** (Sep 29, 2026) | Feasible — deferred idea; not approved for implementation | Connect a regularly synchronized Google Sheet of style/color/size stock and shelf locations. Flag matching PO Queue lines before vendor purchasing; show available quantity, last refresh, and stale/unavailable warnings. Suggested first phase: read-only alerts, no automatic purchase-quantity reductions. Later option: order-specific reservations → confirm physical pull → purchase remainder, preventing double allocation and defining how sheet counts are updated without double deductions. Confirm sheet structure and count-maintenance practices before planning; use conservative product matching. User requested logging only, with no module changes. |
| **CFO AI assistant** (Aug 7) | Feasible — AI layer is the easy part | Needs financial data intake (payroll/labor import) + an order cost-allocation model (stitches/colors/qty as labor proxies, tunable, not hidden in AI) first; email-ROI angle depends on the email hub. Builds on Ask AI machinery. Pattern generalizes to production/sales/purchasing analysts. |
| **Email correspondence hub** (Aug 7) | Core very feasible; read receipts weak | Gmail API read-only on CSR inboxes; customer match is exact, invoice match is heuristic + confirm. Track replies, not opens. Feeds the CFO agent's ROI data. |
| **Chipply CH2** (confirmed) | Straightforward | Customer-profile Chipply section, Chipply reporting kept separate from Printavo revenue, CSV imports, reassignment UI. |
| PQ3b: in-house packing slips / box labels | Straightforward | Renders from local data (Printavo blocks packing-slip downloads). |
| Internal customer portal (branding, popular styles, categories) | Straightforward | Hub-owned enrichment tables keyed to Printavo customer ID. |
| Color catalog/database (reusable for Breezy tweak app) | Moderate | Overlaps with curation Task #6's catalog — design once, serve both. |
| Catalog search API for Tyler's other app (key-authed, images) | Moderate | Same overlap — Task #6's catalog is the natural foundation. |
| Complete-backup scheduled resync of frozen archive | Moderate | Periodic re-verification pass. |
| External analytics hub (Fireflies, JustCall, GA, Meta, …) | Larger | Needs role-based access tiers first. |
| Sales & front-end support tools (follow-up reminders, notifications) | Moderate | Gets much smarter after the email hub exists. |
| Knowledge base / maintenance log / preset reports library | Straightforward | Independent, schedule anytime. |
| Stock checker (standalone idea, Aug 4) | — | Superseded — folded into curation Tasks #5–7. |

## 4. Suggested sequencing (for discussion)

1. **Accept curation Task #5** — highest immediate value for sales/CSR, lowest risk, foundations already exist.
2. **Task #6 catalog** next — it also unlocks the color catalog + external catalog-API roadmap items in one build.
3. **Email correspondence hub** as the next new plan after curation — it's a prerequisite for the CFO agent's ROI angle and supercharges the sales support tools.
4. **CFO assistant** staged after that: financial intake → cost model → analyst. The intake/cost-model phases can start earlier if desired — they don't need the email hub.

Loose ends worth remembering: Mint Bucks email mode still test-only (one env-var flip when ready); Printavo⇄moMINTum poller dormant; PQ3b outstanding.
