---
name: Mint Bucks shared live-DB coupling
description: Operational coupling between the hub's Mint Bucks module and the standalone app via the shared production DB — settings, one-shot ledgers, and email-test-mode hazards.
---

The hub's Mint Bucks module and the standalone Mint Bucks app share ONE live production Postgres. Three couplings follow that are invisible from hub code alone:

**Rule 1 — shared settings are dual-control.** `printavo_enabled` / `rewards_enabled` live in the shared settings table; toggling automation in the hub also starts/stops the STANDALONE app's poller.
**Why:** Both apps read the same rows to decide whether their own poller runs.
**How to apply:** Never toggle these during testing on live data; a "hub-only" toggle does not exist.

**Rule 2 — one-shot ledgers are shared.** Manual hub polls/scans consume `notification_log` and `reward_awards` claims even in email-test mode: the redirected `[TEST→…]` email marks the claim "sent", so the standalone app will never send the real customer email for that order/award.
**Why:** Idempotency claims are per-database, not per-app — that is exactly what prevents double-sends, but it also means a test-mode send permanently swallows the real one.
**How to apply:** No manual poll/scan triggers on live data until `MINTBUCKS_EMAIL_MODE=live` or poller ownership has flipped to the hub.

**Rule 3 — forms that echo server-populated read-only fields break write-guards.** The ported Settings page prefilled credential fields from GET (hub env overrides) and sent them back on every save — tripping the server's credential write-block (400) even for unrelated toggles. Read-only e2e passed; only a save attempt exposed it.
**Why:** ENV-override reads + write-blocked keys means any round-tripped field is poison; and read-only test plans cannot catch save-path bugs.
**How to apply:** When a server blocks writes to certain keys, the UI must omit them from the payload entirely (and render them read-only), and at least one guarded save round-trip belongs in the test plan.
