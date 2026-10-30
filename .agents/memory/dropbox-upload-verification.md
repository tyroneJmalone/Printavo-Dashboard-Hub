---
name: Dropbox temporary upload verification
description: Temporary upload acknowledgments differ from normal file-upload metadata.
---

Dropbox temporary-link upload consumption returns `content-hash`, not a file
metadata object or ID. Verify the acknowledgment hash, then independently fetch
metadata by the intended destination path and verify path, file type, size and
Dropbox content hash before permitting source removal.

**Why:** An upload succeeded but verification requested metadata with an
undefined ID, producing HTTP 400 and correctly holding downstream deletion
and task completion.

**How to apply:** Tests must use the provider's actual temporary-upload response
shape, not the normal upload endpoint's response. Existing archives can be reused
only after the same full verification. An old uncertain action remains held
until explicitly reconciled; fixing code does not authorize replay.
