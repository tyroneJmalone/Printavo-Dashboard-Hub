---
name: Mint PDF Sorter — packing slip / shipping label sorter and matcher
description: Python pdfplumber parsing of Printavo packing slips + USPS labels, 9 presets incl. custom_sort builder, name-matching algorithm, size sort order, match report CSV; PORTED INTO HUB 2026-07-18 (/label-sorter)
---

# What it does
Staff export two PDFs per shipment batch: Printavo packing slips (1 page/order) + USPS shipping labels (1 label/order, from a Printavo-connected shipping app). Both arrive in arbitrary order. App sorts slips by Style→Color→Size→Order# and reorders the labels PDF to pair 1:1 with the sorted slips, plus a match-report CSV. Stateless: in-memory job Map, temp files in /tmp/mint-jobs/<jobId>, no DB, no auth, no Printavo API calls.

# MODERN monorepo template ✅
Same pnpm workspace layout as Hub (artifacts/api-server + artifacts/<app>, lib/api-spec OpenAPI→Orval codegen, lib/api-client-react, lib/api-zod). Near-verbatim port like Breezy/PO Builder/Mint Bucks.

# Architecture quirk: Python child process
Express spawns `python3 processor_cli.py <preset> <slipsPath> <outDir> <labelPaths...>`; deps: pdfplumber (layout-aware extraction — critical for Printavo slip column layout), pypdf (page reordering), pandas (CSV). Hub must keep Python runtime + these packages. pdfplumber called with x_tolerance=1, y_tolerance=3.

# 9 presets
combine_labels (merge label PDFs), sort_slips (Style→Color→Size→Order#), sort_slips_name (…→Last Name), sort_slips_custom (…→Last Name→Custom Field), sort_slips_custom_first (Custom Field→Last Name), sort_labels (sorted slips + matching labels), sort_both (+ CSV report), match_labels (reorder labels to slips' EXISTING order — no slip sorting), custom_sort (user-built field list, ≥1 field required; `--sort-fields` JSON array to CLI; frontend builder saves presets in localStorage key `mintSortPresets`).
needsPackingSlips = all except combine_labels; needsLabels = combine_labels/sort_labels/sort_both/match_labels; labels capped at 20.

# Parsing rules (fragile — tied to Printavo slip template + USPS label format)
- Slip: order # via `Order #(\d+)`; first line of page is reliably customer name ("Last, First"); "Customer Shipping:" block often polluted by column artefact tokens {DELIVERY, SHIPPING, METHOD} → fall back to first-line name; style regex after Sort# (`\d+ <STYLE> SanMar|SS Activewear|...`); size/color from `(SIZE) (color...) qty $price` pattern, last match wins.
- Label: tracking via USPS `9xxx xxxx...` grouped pattern or 22-25 digit run; name via "SHIP <NAME>\nTO:" pattern, else all-caps line followed by digit-containing line (excluding MINT PRINTWORKS/USPS noise lines).

# Name matching (slip "Last, First" ↔ label "FIRST LAST")
1. Exact normalized-name match (uppercase, strip punctuation, drop stop tokens USA/US/UNIT/APT/STE/SUITE), try shipping_name then customer_name, first unused label wins.
2. Fallback token-set: match if either name's token set (tokens >1 char) is a subset of the other.
Statuses: matched (method: "exact name"|"token name") / missing_label / unused_label (appended at CSV bottom).

# Size sort order (business constant)
XS S M L XL 2XL 3XL 4XL 5XL 6XL YXS YS YM YL YXL OSFA OSFM (unknown → rank 99).

# API (as ported into Hub 2026-07-18)
POST /api/sorter/process (multipart: preset, sort_fields JSON array for custom_sort, packing_slips ×1, labels ×20 max) → {jobId, outputs[{key,filename,label,mime}]}; GET /api/sorter/jobs/:jobId/files/:key download. Outputs always zipped too (zip output forced to key "zip"). Behind requireStaff. Hub page /label-sorter; python lives in artifacts/api-server/python/ (spawned from source tree, not dist). Jobs Map is in-memory: downloads 404 after api-server restart (accepted, matches source).

# Hub integration ideas (from its context doc)
order_number on every slip = Printavo order # → natural join key: enrich match report from Printavo API, write tracking numbers back to orders, batch shipment manifest by style/color/size.

# Env
No secrets at all. Clean repo.
