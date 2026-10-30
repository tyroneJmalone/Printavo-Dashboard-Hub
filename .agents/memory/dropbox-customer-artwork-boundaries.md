---
name: Dropbox customer artwork boundaries
description: Security and ownership rules for customer artwork sourced from Dropbox.
---

Hub access to customer Dropbox artwork is read-only. Store customer folder links and staple-logo annotations in Hub-owned data; never rename, move, overwrite, upload, or delete Dropbox files.

Dropbox IDs remain stable when items move, so recognizing a saved ID is not enough to authorize access. Resolve its current metadata and require its canonical path to remain segment-contained by the customer’s currently linked root before returning metadata or a temporary download link.

**Why:** A bookmarked file moved into another customer folder would otherwise remain downloadable through its old stable ID.

**How to apply:** Enforce the linked-root boundary server-side for every browse, metadata, preview, and download request. Bind continuation tokens to the customer and root context rather than returning raw provider cursors.

Successful Dropbox authentication does not establish access to saved customer
folders. Check a known mapped folder ID before declaring a reconnect successful.

**Why:** A different Dropbox account authenticated successfully and could open
public shared links, but all mapped client folder IDs returned not_found.
Renewing that same account did not help; choosing the correct account restored
access without changing any mappings.

**How to apply:** When many saved folders become inaccessible, distinguish
expired credentials from wrong-account access. Verify the account choice with
the user before repeated renewals, remapping, or changes to folder sharing.