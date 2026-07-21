# Handoff: Printavo task-sync interval poller (hub-side, PT5)

Date: 2026-07-21
Audience: whoever maintains the standalone moMINTum app

## What changed in the hub

The hub's Printavo ⇄ moMINTum task sync (previously manual-trigger only via
`POST /api/printavo-tasks/sync-now`) now has an interval poller that runs a
full sync cycle every 5 minutes.

- The poller is **dormant by default**. It only starts when the hub api-server
  boots with `PRINTAVO_TASK_SYNC_ENABLED=true` (plus `MOMINTUM_DATABASE_URL`
  and Printavo credentials present).
- Overlap-guarded: a tick is skipped if a cycle (manual or scheduled) is still
  running. Manual sync-now keeps working regardless of the flag.
- Poller state (enabled/running/lastPollAt/lastError) is exposed on
  `GET /api/printavo-tasks/status`.

## What this means for the standalone app

- Nothing in the standalone app needs to change. No schema changes were made;
  the sync continues to perform data-row writes only (tasks table), and the
  link table lives in the hub's own database.
- Once the flag is enabled, twins of Printavo tasks will appear/update in the
  shared live database automatically every ~5 minutes instead of only when a
  hub admin clicks sync. Task rows created by the sync have
  `source = 'printavo'`.

## Operational rule (critical)

`PRINTAVO_TASK_SYNC_ENABLED=true` may be set in **at most ONE hub environment
at a time** (dev OR deployment, never both). Each hub environment has its own
hub database — and therefore its own `printavo_task_links` table — but both
write twins into the SAME live moMINTum database. Two enabled environments
would each import every Printavo task independently → duplicate twins.

Enable procedure: confirm the flag is unset everywhere else → set the secret
in the chosen environment → restart that environment's api-server.
