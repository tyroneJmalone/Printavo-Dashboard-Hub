---
name: KB learning filters
description: Tyler's requirements for the future knowledge-base-learning feature (proposed task: learn from real conversations with human approval)
---

# Knowledge-base learning — required filters

The rule: when the KB-suggestion feature gets built, it must only analyze conversations **linked to a real Printavo customer**, and additionally skip obvious bulk mail (unsubscribe headers, no-reply/newsletter senders).

**Why:** Tyler explicitly asked (Aug 2026) that irrelevant mail — e.g. a Spotify newsletter — never be analyzed for KB suggestions or waste money/attention. The customer-link filter excludes nearly all noise for free since bulk senders never match a customer record.

**How to apply:** Filter at the analysis/learning layer, NOT at sync time — the sync deliberately stores everything (raw record is cheap and keeps options open). Human approval is still required before anything lands in the KB.
