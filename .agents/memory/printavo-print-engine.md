---
name: Printavo print engine (workorders, packing slips, box labels)
description: How the Workorder Manager app prints docs — public vs session-gated URLs, Puppeteer login flow, PrintNode delivery, category→status routing — for Hub Print Queue module
---

# Document URL access model (critical constraint)
- **Workorder URLs are PUBLIC**: `{shop}.printavo.com/work_orders/{random-hash}` — fetchable server-side with no auth. Exposed as `workorderUrl` field in v2 GraphQL on Invoice/Quote.
- **Packing slips & box labels are SESSION-GATED**: `www.printavo.com/invoices/{id}/packing_slip` and `/box_labels` require a logged-in browser session cookie. API token headers DO NOT work. `X-Frame-Options: SAMEORIGIN` blocks iframes.
- v2 GraphQL exposes `workorderUrl`, `packingSlipUrl`, `url` (invoice URL) directly on orders — add to Hub sync queries.

# Session auth workaround (proven working)
- Puppeteer headless-Chromium login to `/users/sign_in` with PRINTAVO_EMAIL + PRINTAVO_PASSWORD: realistic UA + viewport, `navigator.webdriver` override, values set via native setter + input/change events, wait for post-login redirect.
- Extract all cookies → cache combined cookie string for 2 hours; clear on 401/403/redirect-to-login.
- Then plain `fetch` with the cookie header retrieves the gated HTML (bypasses WAF that blocks headless browsers hitting the URLs directly); HTML fed to `page.setContent()` for PDF.
- Note: a context doc in that repo says packing slips are "generated from GraphQL data" — OUTDATED; the code fetches real Printavo HTML via session auth.

# PDF generation
- puppeteer-core + Nix Chromium (`CHROMIUM_EXECUTABLE_PATH` env override; hardcoded /nix/store path fallback). Args: --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu.
- Workorder PDF: fetch public HTML, inject `<base href>` after `<head>`, setContent, inject print CSS (exact bg colors via print-color-adjust, grey header/imprint backgrounds), Letter format, scale 0.75, 0.2in margins, printBackground. Optional `.printing__keep-together { display:none }` to exclude attachments.
- Packing slip / box label PDF: session-fetch HTML, `<base href="https://www.printavo.com">`, Letter, 0.25in margins.

# Manual bulk print (browser mode, no PrintNode)
- POST workorderUrls (max 50, validated to contain printavo.com/work_orders/) → server fetches each public HTML staggered 200ms, injects base tag, concatenates into one HTML doc with `.doc-wrapper { page-break-after: always }` → popup window → single Ctrl+P.
- Packing slips/box labels in manual mode: can't fetch server-side per user session → returns "launcher" HTML page with links user opens in their own logged-in Printavo tabs.

# Auto-print engine (PrintNode delivery)
- node-cron every N hours (1–24, default 6). Single-flight guard (isRunning).
- Flow per order in configured source statuses: skip-if-printed check (print_jobs table by order id; reprint flagged) → fetch imprint `typeOfWork` categories → map category→target status (case-insensitive first match, `__fallback__` entry) → generate enabled doc PDFs → PrintNode submit (pdf_base64, per-doc printer + copies, one-sided) → on success statusUpdate mutation to target; on failure set errorStatusId. Status-update failure after successful print is logged, not fatal.
- Dry-run mode simulates everything, logs jobs as dry_run.
- print_jobs history table: order ids, source/target status, printnode job id, status (pending/processing/printed/failed/dry_run), error, is_reprint, printed_at.
- Config single-row table: enabled, schedule_hours, source_status_ids (csv), error_status_id, per-doc-type enable/printer/copies, dry_run, category_mappings jsonb.

# v2 field gotchas (from that repo's own live-error logs)
- LineItemGroup has NO `name` — use `style { name, styleNumber }` + `color { name }`.
- LineItem has NO `quantity`/`unitPrice`/`total` fields in some contexts; `description` returns size name ("S","M","L"). (Backup repo successfully uses `qty`, `price`, `size`.)
- Rate-limit etiquette used: 600ms between order pages, 200ms between workorder HTML fetches.

# Hub requirements
- Secrets: PRINTAVO_PASSWORD (for session), PRINTNODE_API_KEY. Printavo tokens expire every 6 months.
- Hub Print Queue needs: manual combined-print popup flow, launcher-page fallback, auto-print engine w/ category routing, PrintNode printer list/select, job history.
