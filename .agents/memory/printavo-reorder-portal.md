---
name: Reorder Portal — public customer order lookup + reorder requests
description: The only customer-facing app; live Printavo lookups (no DB, no throttle), unauthenticated email/company search (security gaps), Resend email-only submission; older template; user says "not fully dialed in"
---

# What it does
Public portal: customer searches by email or company name → sees up to 15 recent order cards (mockup, status, total, due dates, publicUrl) → reorder modal with per-product size/qty grids → submits → HTML email to info@mintprintworks.com via Resend connector. Nothing persists.

# User-stated status (July 2026)
"Not fully dialed in but was on the right track" before Tyler switched projects. Treat as a working prototype, not finished.

# OLDER client/server/shared template (confirmed — needs restructure to monorepo)

# Architecture facts
- NO database at all — storage.ts is an empty stub; everything live from Printavo per request.
- NO Printavo throttle whatsoever (fires unthrottled account-limit traffic on every customer search — worst offender for the shared 10 req/5s limit).
- Creds properly in env: PRINTAVO_API_EMAIL + PRINTAVO_API_TOKEN ✅. No hardcoded secrets ✅.
- Resend via Replit connector using raw fetch to REPLIT_CONNECTORS_HOSTNAME with REPL_IDENTITY/WEB_REPL_RENEWAL token (older pattern; Mint Bucks uses @replit/connectors-sdk — standardize on SDK in Hub).
- Search: Printavo `invoices(first:15, sortOn: VISUAL_ID, sortDescending, query:$search)` (fuzzy) then server-side filter — email must match contact.email exactly; company uses substring `includes()`.

# ⚠️ Security gaps (public app — must fix in Hub rebuild)
1. Unauthenticated lookup: anyone who knows/guesses a customer email sees their order history, totals, mockups, publicUrl links. No verification (no magic link / code).
2. Company search is SUBSTRING match — "Mint" could return other companies' orders with overlapping names.
3. No API rate limiting / abuse protection on the public endpoints (email-enumeration scraping possible; also each probe burns Printavo quota).
4. HTML injection in the reorder email: notes/product fields interpolated into email HTML unsanitized (email-client HTML injection; low severity, internal recipient).
5. Each search sees only the 15 newest invoices matching the fuzzy query (VISUAL_ID desc) — older matching history invisible (functional gap, also masks the fuzzy-query cost).

# Reorder email content
Per-line-item breakdown {productName, color, itemNumber, sizes[{size,qty}]} + subtotals + grand total pcs + customer notes. Zod-validated (reorderRequestSchema). SALES_EMAIL hardcoded info@mintprintworks.com.

# Line-item shaping worth porting
Dedup key = itemNumber|color|description (lowercased) merging qty + size counts across lineItemGroups (first:5) × lineItems (first:8); mockup fallback: line-item mockup → imprint mockup. SIZE_LABEL_MAP enum→label table in shared/schema.ts (size_yxs…size_5t).

# Hub notes
- Hub plan already right: portal reads the shared cache (no live Printavo per search), reorder requests persist to reorder_requests + email, separate public front-end with restricted API scope.
- Add in rebuild: customer identity verification (emailed code/magic link), exact-match company or verified association, per-IP rate limiting, sanitize email HTML.
- Statuses endpoint exists but the status list should come from the Hub's shared status cache.
