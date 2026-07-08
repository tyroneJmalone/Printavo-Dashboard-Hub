---
name: BreezyTweakart reference app
description: Takeaways from Tyler's separate Breezy Tweak SaaS repo (artwork tweak tool) — catalog consumer expectations, Printavo temp-URL file push, image pipeline patterns. Reference only, never integrated.
---

# BreezyTweakart (separate SaaS, reference only)

Reviewed July 2026 from a temporarily-public repo (tyroneJmalone/BreezyTweakart, private again afterward). Tyler's standing intent: functionality stays separate from the Hub, but keep the door open to borrow ideas later.

## Relationship to the Hub color database
Breezy embeds a snapshot of the SAME ~6,199-color catalog documented in [printavo-color-catalog.md](printavo-color-catalog.md) (as a hardcoded Python list, not a DB). The Hub's color module is planned as the SOURCE for Breezy's catalog.
**How to apply:** the Hub color module needs a versioned export (JSON/CSV of pantone, hex, RGB, CMYK, HSB, pre-computed LAB, vendor thread/ink matches) that Breezy can consume; matcher semantics must stay Delta-E CIE2000 over pre-computed LAB so both apps rank matches identically.

## Printavo file patterns (beyond what PO Builder notes cover)
- `productionFileCreate` cannot take a binary upload — Printavo fetches from a URL. Breezy serves the file at a temp public URL (10-min token route) for the mutation to fetch. Any Hub feature pushing files to Printavo needs the same public-URL hop (object storage presigned URL would do).
- Mockup/production file download is a plain GET on API-provided URLs.
- Breezy stores per-user Printavo email+token; Hub is single-account — no conflict.

## Ideas worth borrowing later
- OpenCV K-Means dominant-color detection on uploaded logos → auto-suggest Pantone matches. Direct fit for the Hub's planned "customer logo colors" enrichment field.
- Heavy image ops serialized behind a global lock to avoid OOM; vector (AI/EPS/PDF) → raster via Ghostscript, staging files in /tmp to avoid FUSE mmap issues.
- External services in use: Vectorizer.ai (pre-shrink to <33MP first), Topaz Labs upscaling, local rembg.
