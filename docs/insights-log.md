# Insights & Ideas Log

A curated, dated log of explanations, insights, and decisions from our build chats — the stuff worth coming back to. Newest entries at the top of each month. Say **"log that"** after any explanation you want captured, and new entries are also added automatically whenever a substantive insight comes up.

---

## July 2026

### Jul 21 — Full backup = full history for every feature (the plan)
The backup module's historical backfill lands in the **same database tables the Hub already reads** — not a separate vault of files (that's how the old standalone backup app worked). Once it runs, a 2019 order looks exactly like last week's order to Reports, order detail, search, and every future feature. Payments already go back to **December 2017** (18,635 transactions); orders currently cover the 12-month window (~3,500) and the backfill adds everything older (~15–19k more). Caveat: history means **records, not timelines** — we get every old order's final state, but not when its statuses changed along the way.

### Jul 21 — Printavo keeps no timestamps or logs for line-item status changes
There is no way to ask Printavo *when* a line item became "Needs Ordering" or "Ordered" — the API exposes only the current status, with no history, no audit log, and no activity feed. It doesn't even bump the order's "last updated" time when a line-item status changes (verified live). **What we did about it:** the Hub now records every product-status transition it observes (old value → new value, timestamped) in its change-events log. Accuracy is within ~5 minutes for recent orders since we can only log when we *notice* the change. The past before this was turned on is unrecoverable. Exception: orders placed through the Hub were always exactly timestamped in the PO Log.

### Jul 21 — How all Printavo traffic shares one throttled pipe
Every Hub feature that talks to Printavo goes through a single gateway that spaces requests 620ms apart (≈8 requests per 5 seconds, safely under Printavo's 10-per-5s account-wide cap) and retries once after a 429. That's why the 5-minute order sync, the task sync (~65 requests worst case), and everything else can coexist without tripping the limit — they queue up behind each other instead of colliding.

### Jul 20–21 — Task-sync flag: one environment only, ever
`PRINTAVO_TASK_SYNC_ENABLED` may be true in AT MOST ONE environment (dev OR published — never both). Each environment keeps its own link table, but both write task "twins" into the SAME live moMINTum database — two enabled environments would each import every Printavo task and create duplicates. Currently ON in dev only, deliberately not shared to the deployment.

### Jul 19 — Mint Bucks test-mode emails still "use up" the real send
Even with emails redirected to Tyler (`[TEST→…]`), a manual poll in the Hub consumes the shared one-shot ledgers (`notification_log`, `reward_awards`) — so the standalone app will never send the real customer email for that order/award. Avoid manual poll triggers on live data until email mode is live or poller ownership has flipped to the Hub.

### Jul 17–18 — Rules for sharing moMINTum's live database
The Hub reads/writes the standalone moMINTum app's LIVE production database. Hard rules that keep both apps safe: member identity resolves **by email only** (oldest row wins); the standalone app's Clerk user IDs are never written from the Hub; missing members are created just-in-time under a database lock (a duplicate-member race was actually found and fixed during testing); Hub-only tables are additive and must never be dropped by the standalone app; every Hub change visible in the standalone app gets a handoff doc in `handoffs/`.

### Jul 16 — Printavo hides line-item status changes from normal syncing
Flipping items to "Needs Ordering" leaves the order's updated-timestamp untouched, so a normal change-detection crawl never notices. That's why the sync engine has a dedicated **product-status sweep**: a slim scan of just line-item IDs + statuses at the start of every sync cycle, diffed against our database, so the Vendor Orders queue stays fresh.

### Jul 13–16 — Vendor pricing semantics (burned us twice)
SanMar's regular cost is **casePrice**, NOT piecePrice — this was gotten wrong twice before it stuck. S&S uses piecePrice. S&S also labels combined sizes like "2/3X". Full notes live in the project memory.

### Jul 13 — Test-order safety rule
All real-write testing uses order **#22251** ("TEST DO NOT ORDER") exclusively. Order #19004 is banned: Printavo automations fired real customer emails when its status changed. If a different test order is ever needed, ask Tyler first.

### Jul 13 — Printavo's rate limit is account-wide
10 requests per 5 seconds covers ALL apps on the account at once — the Hub shares that budget with Tyler's other live Printavo apps until they're decommissioned. The Hub's 5-minute poll uses ~23% of it, leaving headroom.

### Jul 9–10 — Why the sync re-crawls everything every 5 minutes
Printavo's API has no "give me what changed since X" filter and can't sort by update time (verified against their live schema). The only reliable strategy: re-crawl all orders newest-first every 5 minutes, fingerprint each record (content hash), and store only what actually changed. ~140 requests, ~2.3 minutes per poll.

### Jul 9–10 — Printavo renders timestamps in random timezones
The same instant comes back in varying timezones between fetches. Every fetched record is normalized to UTC before hashing/storing — without this, the sync would log thousands of phantom "changes". This is a permanent rule: never hash a Printavo record without timestamp normalization.

### Jul (mid) — Two orders are stored incomplete by design
Orders **20104** and **20714** have more than 25 line-item groups — beyond Printavo's query complexity cap even at generous limits — so their line items are partially stored. Exclude them from report spot-checks.
