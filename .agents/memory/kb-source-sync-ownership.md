---
name: Knowledge source sync ownership
description: Environment ownership rule for scheduled Google Drive knowledge-source ingestion
---

Google Drive knowledge-source scheduling belongs to the production environment only. Development should use the manual Sync now action.

**Why:** Running the scheduler in both development and deployment can process the same Drive revisions concurrently, create duplicate review work, and produce misleading stale-source warnings.

**How to apply:** Keep `KB_DRIVE_SYNC_ENABLED=true` production-scoped, not shared. Only enable it in development if production scheduling has first been disabled.