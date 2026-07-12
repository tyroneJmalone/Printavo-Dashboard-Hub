---
name: Vendor catalog search — Tyler's requirements
description: Deferred cross-vendor catalog search portal; requirements Tyler stated before tabling it
---
# Vendor catalog search portal (TABLED, will return — Tyler, 2026-07-12)

Tyler explicitly tabled the SanMar+S&S catalog mirror / keyword search build but said "we will definitely come back to it."

Requirements he stated up front:
- Cross-vendor keyword search (e.g. "navy trucker hat") across all vendor catalogs.
- **Must be consumable from ANOTHER app Tyler built, not just the Hub.** Design the search as a read-only HTTP API on the deployed api-server (key-authenticated), not Hub-internal code and not direct DB sharing.
- **Must include product images.** Both vendor catalog feeds carry image URLs (SanMar bulk/delta CSV has image columns; S&S styles/products API returns cdn.ssactivewear.com image paths). Decide at build time: hotlink vendor CDNs vs mirror into object storage (mirroring is safer if his other app is public-facing or vendor CDNs block hotlinking).

**Why:** external-consumer requirement changes the architecture (public API surface + auth + stable JSON contract) — cheaper to design in from the start than bolt on.
**How to apply:** when catalog search work resumes, plan the mirror + a versioned read-only search endpoint (with images) as one deliverable; confirm hosting/auth details with Tyler before building.
