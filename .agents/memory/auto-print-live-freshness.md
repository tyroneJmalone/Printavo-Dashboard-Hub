---
name: Auto-print live freshness
description: Auto-print discovery must be independent of recent-order sync and fail closed on incomplete reads.
---

Auto-print must discover source-status matches directly from Printavo, with no invoice-age cutoff. Keep that separate from the mirror's recent-order sync window. Budget exhaustion, unsupported filtering, and incomplete pagination mean an unknown candidate count, not zero matches. Never fall back to cached statuses or start a full historical crawl.

**Why:** Older invoices can change status after leaving the routine sync window. An unbounded replacement crawl would delay printing and consume the shared API quota; a partial response falsely labeled complete hides missed work.

**How to apply:** Retain bounded status-filtered discovery, visible discovery freshness/failure, and exact live identity/status checks immediately before physical submission. Preserve one-shot status writes and durable print reservations. Test with offline engine boundaries or dry runs, without sending physical jobs or changing customer statuses.
