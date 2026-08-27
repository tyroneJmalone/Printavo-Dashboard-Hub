---
name: Dropbox customer artwork boundaries
description: Security and ownership rules for customer artwork sourced from Dropbox.
---

Hub access to customer Dropbox artwork is read-only. Store customer folder links and staple-logo annotations in Hub-owned data; never rename, move, overwrite, upload, or delete Dropbox files.

Dropbox IDs remain stable when items move, so recognizing a saved ID is not enough to authorize access. Resolve its current metadata and require its canonical path to remain segment-contained by the customer’s currently linked root before returning metadata or a temporary download link.

**Why:** A bookmarked file moved into another customer folder would otherwise remain downloadable through its old stable ID.

**How to apply:** Enforce the linked-root boundary server-side for every browse, metadata, preview, and download request. Bind continuation tokens to the customer and root context rather than returning raw provider cursors.