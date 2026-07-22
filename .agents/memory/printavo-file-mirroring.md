---
name: Printavo file mirroring quirks
description: Which Printavo file URLs are downloadable without auth, and why PDF checksums never match across time.
---

# Printavo file mirroring (backup module B3)

- **No-auth downloadable:** `publicPdf` (hash URL on mintprintworks.printavo.com, real `application/pdf`), mockup `fullImageUrl`, and production-file `fileUrl` (both on cdn.filepicker.io — stable handles).
- **NOT downloadable / not files:** `packingSlipUrl` + `.pdf` variant → 401 auth wall; `workorderUrl` → HTML page only. Don't retry these in future backup work.
- **PDF regeneration quirk:** Printavo regenerates the public PDF per request and embeds the generation time in `/CreationDate` — two downloads differ by exactly 3 bytes even when the order is unchanged.
  - **Why:** verified live by byte-diffing a mirrored copy vs fresh fetch (identical size, 3 differing bytes, all inside `/CreationDate (D:...)`).
  - **How to apply:** any backup-integrity check comparing PDF checksums across time must strip or ignore `/CreationDate`; same-URL-same-hash assumptions are false for PDFs (fine for filepicker CDN assets).
- **PDF bytes change under a stable URL** when the order is edited — that's why the file registry always requeues an order's `public_pdf` row whenever the order changes (snapshot keeps only the latest version, matching what Printavo itself holds).
- `thumbnailUrl` is a filepicker transform of `fullImageUrl` — never worth mirroring.
