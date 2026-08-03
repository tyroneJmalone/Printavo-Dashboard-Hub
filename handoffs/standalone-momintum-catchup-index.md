# Catch-up index: moMINTum changes since the standalone was published (~Jul 19, 2026)

Every moMINTum change made in the Hub workspace since then already has its own
handoff doc in this folder. To bring the standalone app up to date, paste these
to the standalone agent **in this order** (they build on each other):

1. `standalone-momintum-list-groups.md` — collapsible list groups in the sidebar (Jul 19)
2. `standalone-momintum-two-way-completion.md` — two-way completion sync with Printavo (Jul 19)
3. `standalone-momintum-printavo-order-links.md` — clickable "(INV #NNN)" links in task titles + "Open order in Printavo" in the detail dialog (Jul 20)
4. `standalone-momintum-send-to-printavo.md` — "Send to Printavo" on tasks (Jul 20)
5. `standalone-momintum-task-routing-overhaul.md` — task routing/visibility for Printavo-synced tasks (Jul 20)
6. `standalone-momintum-sync-safeguard-confirmations.md` — confirmation prompts before acting on synced tasks (Jul 20)
7. `standalone-momintum-task-sync-poller.md` — manual "sync from Printavo" button (Jul 21; the polling itself runs in the Hub — the standalone side is just the button/UI portion described in the doc)
8. `standalone-momintum-task-counts.md` — accurate task counts on the Lists page and Dashboard (Jul 21; server-computed `activeTaskCount` + trashed/quarantined tasks excluded from dashboard numbers — apply after #5, it builds on the quarantine filtering)
