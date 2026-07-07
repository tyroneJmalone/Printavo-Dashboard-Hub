---
name: Mint Bucks — store credit ledger, rewards engine, throttled Printavo client
description: Credit/redemption schema, dedup ledgers, advisory-lock budget enforcement, proven 620ms Printavo throttle, orders-union quirks (quotes invisible to invoices query, no paidAt)
---

# What it does (10th app, not on original list)
Promotional store-credit system ("Mint Bucks"): manual + rule-based auto credits from paid Printavo invoices, balance/partial-redemption/expiry tracking, PDF gift certificates w/ QR to public balance-check page, customer emails (issued/redeemed/expiry/"you have credit" on new orders), reporting dashboard.

# System-of-record warning
Credit balances, redemptions, expiry live ONLY in this app's Postgres — Printavo knows nothing about credits. Migration must preserve this ledger exactly.

# Schema (Drizzle)
- customers (id, name, email unique, phone, company_name) — synced from Printavo CONTACTS (person-level; Printavo `customers` are company-level and have NO email).
- credits: code unique `MB-{8-hex-uppercase}`, amount, amountRemaining, status active→partially_redeemed→redeemed / voided / expired (expiry not yet automated), sourceRuleId, expiresAt.
- redemptions: creditId, customerId, amountApplied, invoiceRef, redeemedAt.
- reward_rules: rewardType flat|percent_paid|percent_total|tiered, rewardParams json, conditions json (tags/status/total min-max), startsAt/endsAt.
- reward_awards: DEDUP LEDGER, unique (ruleId, printavoInvoiceId=internal id), status processing→pending→issued/rejected.
- notification_log: unique (customerId, printavoOrderId) — idempotent "you have credit" emails.
- settings: KV store; sensitive values AES-256-GCM encrypted with SETTINGS_ENCRYPTION_KEY.

# Rewards engine concurrency (load-bearing patterns)
- Budget check + award claim atomic inside `pg_advisory_xact_lock`; annual budget counts processing+pending+issued; reserved at claim, released on reject; approval must NOT re-check budget.
- Credit insert + award→issued flip in one transaction guarded on still-"processing" status.
- Stale-processing sweep (10 min) must key off LAST-UPDATED time, not created time (else mid-approval reclaim → double award).
- Modes: auto (issue immediately) vs approve (pending queue). "Paid on/after start date" only approximable via createdAt — Printavo has NO paidAt field.

# Throttled Printavo client (proven — port to Hub as the shared gateway)
- Rate limit 10 req/5s ACCOUNT-WIDE (per email/IP) — shared across ALL apps on the account. Serialize via promise-gate throttle, MIN_INTERVAL_MS=620 (~8 req/5s; 550ms tripped real 429s on startup bursts), retry once after 5200ms on 429.
- Auth headers `email` + `token`. Creds stored AES-encrypted in settings table AND as env secrets PRINTAVO_EMAIL / PRINTAVO_API_KEY.

# Printavo v2 quirks confirmed here (beyond other repos)
- Quotes NEVER appear in `invoices` query — must page `orders` union (Quote|Invoice) with inline fragments `... on Quote {} ... on Invoice {}` (identical field sets; no totalNodes on union connection). Pipeline/open-work features depend on this.
- Job lifecycle: enters as Quote → becomes Invoice on approval. UNVERIFIED whether conversion mints a new id/visualId (probe hinted yes → possible duplicate notification; bounded risk).
- visualId is monotonic with createdAt (verified live) → VISUAL_ID DESC sort is a valid recency proxy; page until createdAt < cutoff.
- invoices filters: paymentStatus UNPAID|PARTIAL_PAYMENT|PAID, tags, statusIds, inProductionAfter/Before. Page size hard-capped at 25 regardless of `first`.
- Newly-paid detection: filter PAID + VISUAL_ID desc + generous lookback + dedup ledger (late payments make pure creation-window scans lossy).
- `orders(query:"<number>")` is FUZZY (matches nickname/PO too) — always filter to exact visualId, never trust nodes[0].
- Two ids: internal numeric id (store this) vs visualId (display); merchant URL deterministic `printavo.com/invoices/{internalId}`, publicUrl is customer-facing hashed link.

# Poller (in-process, default 15 min, interval in settings)
Each tick: rewards scan (PAID invoices vs rules) → order notifications (active credit + no log row → email) → stale-state cleanup (>10 min). Manual triggers exist for all.

# Email
Resend via Replit connector (`@replit/connectors-sdk`, `connectors.proxy("resend", "/emails")`), FROM_EMAIL must be on Resend-verified domain. Non-blocking: all email errors caught+logged, never crash. (Older SMTP notes in repo memory are stale.)

# Misc gotchas (from repo memory)
- pdfkit→fontkit→brotli needs `@swc/helpers` as explicit runtime dep when esbuild externalizes @swc/*.
- PDF certificate (pdfkit) + QR PNG served as binary endpoints (direct <img>/<a> URLs, not React Query).
- Env: DATABASE_URL, SETTINGS_ENCRYPTION_KEY, PRINTAVO_EMAIL, PRINTAVO_API_KEY, FROM_EMAIL, APP_URL/REPLIT_DEV_DOMAIN.

# Hub notes
- Same pnpm monorepo + OpenAPI→Orval contract-first template as Hub — merges cleanly into a unified spec.
- Its handoff doc explicitly argues for ONE shared throttled Printavo client + ONE scheduler fanning out to feature modules — matches Hub plan.
- No auth layer; nothing conflicts with adding auth in front.
