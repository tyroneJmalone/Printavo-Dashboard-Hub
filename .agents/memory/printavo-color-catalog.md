---
name: ColorCatalog — Pantone/thread/ink cross-reference DB with Delta E matching
description: colors table schema (~6,199 rows), stock-propagation rule, server-side Delta E CIE2000 matcher with LAB cache, per-system dedup; no Printavo integration; older non-monorepo template
---

# What it does
Master color cross-reference for production: one Pantone C mapped to Madeira Polyneon (poly embroidery), Madeira Classic Rayon (cotton embroidery), Wilflex RFU screen ink, house-mixed ink, and UltraColor DTF — plus physical shelf location and in-stock flags. ~6,199 rows imported from a vendor Excel sheet. Single source of truth for "customer wants Pantone X — what thread/ink do we have?"

# NOT the monorepo template
Older client/server/shared single-app layout (like Shipping estimator) — needs restructuring for Hub. Has an unused `users` table (auth never implemented).

# colors table (flat, one row = one color combination)
id uuid PK, hexCode, rgb, cmyk, pantoneC, pantoneShelf (physical shelf loc), madeiraPolyneonName/Number + polyneonInStock, madeiraClassicRayonName/Number + rayonInStock, wilflexRfu + wilflexInStock, houseInk, ultraColorDtf. Same Pantone may appear on multiple rows (different thread pairings).

# Stock propagation rule (load-bearing UX behavior — preserve in Hub)
On edit, shelf/in-stock values propagate to ALL other rows sharing the same key:
- same pantoneC → copy pantoneShelf
- same polyneon number → copy polyneonInStock (likewise rayon number, wilflex name)
Mark stock once, updates everywhere that item appears. Implemented as post-update UPDATE ... WHERE key = X AND id != updatedId.

# Delta E CIE2000 matcher (custom server-side impl, port as-is)
- `/api/colors/match?r=&g=&b=&top_n=5` → top N closest per color system: {pantone, polyneon, rayon, ultracolor, wilflex, houseInk}, each entry {id, hex, pantone, system-specific name/number, distance}.
- Pipeline: input RGB → LAB (sRGB→XYZ→LAB, D65) → full CIE2000 formula vs every catalog row → sort asc → dedup per system by name/number key → top N.
- In-memory LAB cache keyed by color id, invalidated on ANY write.
- ΔE interpretation scale used in UI: <2 near identical, 2–5 very close, 5–10 noticeable, 10–15 significant, >15 poor.
- Text searches also chain into Delta E: first exact match's hex → cross-system suggestions.

# API
CRUD /api/colors (+/search?q= case-insensitive partial across all text fields, /bulk insert, PATCH triggers propagation). CSV export client-side. Bulk reload via scripts/import-excel.ts (replaces whole table).

# Hub integration ideas (from its context doc)
Resolve Printavo order color specs → in-stock threads/inks per decoration method; color picker on quotes querying the match API; in-stock-only filtering to avoid production delays.

# Env
DATABASE_URL (Neon serverless in original), SESSION_SECRET (unused). No other secrets — fully self-contained data app.
