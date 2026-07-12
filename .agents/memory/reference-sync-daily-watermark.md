---
name: Reference-entity sync is daily-watermarked
description: How to force pv_statuses (and other reference tables) to refresh after changing a synced GraphQL query.
---

Adding a field to a reference-entity GraphQL query (e.g. statuses) does NOT backfill existing rows until the next reference refresh — reference entities sync on a DAILY watermark, not every poll.

**Why:** Lost significant time waiting for status `color` to appear in pv_statuses after extending statusesPageQuery; repeated manual polls returned "A poll is already running" and, even when they ran, skipped reference entities because the daily watermark was fresh.

**How to apply:** To force a refresh, delete the watermark row first: `delete from entity_watermarks where entity = 'reference_daily';` then trigger `POST /api/sync/poll` (single-flight — if "A poll is already running", the currently-running poll started BEFORE the watermark delete may still skip it; the next poll after it finishes will pick it up). Verify with e.g. `select count(*) filter (where data ? 'color') from pv_statuses;`.
