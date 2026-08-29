---
name: Dropbox artwork previews
description: Security and browser constraints for previewing linked customer artwork inside Hub.
---

Dropbox temporary links should not be embedded directly or handed off through an async popup. Preview browser-safe PDF and raster image files through a same-origin Hub route only after linked-root authorization, with strict MIME/extension allowlisting, a size cap, and private no-store caching. Keep unsupported formats as explicit original-file opens.

**Why:** Dropbox-hosted responses did not render reliably in embedded frames, and async popup navigation remained stuck on touch/browser test flows even when link generation succeeded. A same-origin proxy rendered both PDF and JPG previews while keeping the temporary provider URL out of the UI.

**How to apply:** Use this rule for customer artwork previews and similar Dropbox-backed viewers. Never proxy SVG or arbitrary active content, never weaken the linked-customer root boundary, and never mutate Dropbox as part of previewing.

For list thumbnails, do not depend on Dropbox `get_thumbnail_v2` through the managed connector; its content-endpoint request shape is not supported. Lazy-load raster thumbnails through the authorized inline preview stream, and use labeled format tiles for PDF, AI, EPS, and other non-raster files.