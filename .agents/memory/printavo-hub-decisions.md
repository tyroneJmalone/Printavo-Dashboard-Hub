---
name: Printavo Hub — approved build decisions
description: Tyler's answered decision checklist (July 8, 2026) — consult before making any architecture, auth, migration, or scope choice during the Hub build
---

# Approved decisions (Tyler, July 8, 2026)
- **Staff login required** for the internal Hub. **Why:** single app now holds credits ledger, customer data, purchasing; Tyler also wants per-salesperson filtering (Invoice Owner) and possibly user-defined views later → design staff accounts so filters/views can hang off the user record.
- **Reorder Portal = separate public surface** on the shared backend + internal Reorder Inbox persisting requests (email kept too).
- **Portal security:** emailed one-time code / magic link verification; exact-match company lookup; per-IP rate limiting.
- **Migrate everything** — all app data AND configs (PO history, vendor orders, report schedules, auto-print config, decoration matrices, backup watermarks, color DB, Mint Bucks ledger). Nothing starts fresh.
- **All 6 integrations stay:** ShipStation, EasyPost, PrintNode, Dropbox, OpenAI, Resend ("all active and will remain").
- **S&S test order approved** — one small real order to verify the untested submission path before Ordering goes live.
- **Phased build** — foundation (monorepo + unified schema + throttled Printavo gateway + change-event sync) first, tested, then modules one at a time. Modules standalone in v1; cross-links later.
- One canonical Printavo credential in encrypted secrets; rotate SanMar password after migration.

# Deferred to build time
- Confirm which SanMar/S&S credential sets are current (env variants vs DB rows).
- Size VM disk/bandwidth for full backups during foundation phase.
- Gather all integration keys via secrets when each module is ported.
