# Task #44 — External Review Feedback

**Verdict: greenlight the plan as written.** The architecture is sound and the exclusions are disciplined. Below are refinements to fold in, not objections.

---

## What's right (do not change)

- **"One core, many thin doors"** is the correct framing. Business logic lives once in protocol-independent code; MCP/REST/direct-call are thin adapters. This means the next agent platform — whatever protocol it speaks — is a new adapter, not a new integration. Do not let MCP-specific concerns leak into the core service.
- **Per-consumer tokens with independent scopes and revocation.** Revoking Missive must never affect Zapier or a future chatbot.
- **Two-tier trust model shipping before any external consumer exists.** Retrofitting a scope model after a customer-facing consumer is live is how data leaks happen. Ship the model, keep external-tier consumers disabled.
- **Verbatim-quotable knowledge answers with source attribution.** This is the single most important constraint in the plan — it's what prevents an assistant paraphrasing policy into an error. Enforce it structurally (structured fields returned, not prose), not by prompt instruction alone.
- **Reusing existing customer-matching and quote-draft rails** rather than rebuilding them.

---

## Additions to fold into the task

### 1. Shared guardrail/audit modules (important)

The Hub now has multiple independent AI surfaces: Ask AI, quote extraction, correspondence search, and now the context layer. Each has its own prompts, kill switch, and logging. They will drift — a hallucination pattern fixed in one will persist in the others.

**Do not pause #44 to build a full AI gateway.** But **do** build this task's audit logging, tool-call tracking, kill switch, and citation/attribution validation as **shared, reusable modules** rather than context-layer-specific code, so the other three surfaces can be migrated onto them later without a rewrite.

Concretely: put them where Ask AI and correspondence AI could import them, not inside the context service's own directory tree.

### 2. Effective Date on knowledge entries (important)

The plan specifies title/body/tags/source/review-status. **Add an `effective_date` field** (distinct from created/updated/reviewed dates): the date the fact it states took effect.

Why this matters: source material of different vintages will conflict (e.g. a 2020 blog post says the minimum is 3; a Google Doc updated tomorrow says 24). Review-status is a flag; effective date is the audit trail that resolves which is current and lets staff see *why* a value is what it is.

Related rule to enforce in the ingestion flow: **source material is never canonical.** Blog posts, newsletters, and old Docs are inputs for staff to extract facts from — they must not become servable KB entries themselves. Only reviewed entries with an effective date are returned by the knowledge-search tool.

### 3. Define Pattern B spike verdict criteria upfront

The spike currently has no pass/fail definition, so it will end in a judgment call. Define before starting — suggested: the Hub context note lands before the AI Rule fires in ≥95% of cases across N real conversations, **and** rule-generated drafts demonstrably incorporate note content. Document the measured numbers, not just the verdict.

### 4. Structured fact-accuracy scoring (minor)

Step 4 has staff scoring fact accuracy manually. Fine for launch, but capture it as a **structured field** (per tool call: correct / wrong fact / wrong customer match / missing data) rather than staff impressions — it feeds Step 7's feedback loop directly and is much harder to reconstruct after the fact.

### 5. Caching consideration (minor)

Rate limiting on the doors is specified; caching isn't. Read paths hit Postgres rather than Printavo, so this is not urgent — but an assistant calling ~5 tools per draft across a busy inbox will generate real query volume. Worth a note on whether hot lookups (customer summary, recent orders) get short-TTL caching.

---

## Outside this task, but flagged

**Offsite backups are still unscheduled.** Full history to Feb 2018 with one-click ZIP export exists, but offsite copies (Drive/NAS) remain "logged, not scheduled" — meaning production and backups currently share a single platform dependency. This is the highest-severity open item in the whole system and is a few hours of work. It should jump the queue ahead of new modules.

Other items raised in review, for the backlog (not blockers for #44):

- **Scheduler/API process split.** Sync runs and staff API requests currently share one Express event loop; a slow poll degrades UI responsiveness. Low-effort separation, removes a class of "why is the Hub slow" incidents.
- **Sync engine scaling headroom.** ~2.3 min per 5-min poll (~46% duty cycle) at ~23% of an account-wide 10 req/5s budget shared with Printavo's own UI. Worth modeling behavior at 1.5× current order volume before it becomes urgent. The content-hash-after-timezone-normalization approach is a workaround for a missing API filter — note it as a fragility if Printavo changes timestamp rendering.
- **Sister-app shared-database coupling.** moMINTum/Mint Bucks writing against standalone apps' live production DBs with email-only identity mapping is the most likely source of a subtle, late-surfacing data-integrity bug. Mitigations are thoughtful; the weak point is the join key (people change email addresses).
- **Test order #22251** produces customer-visible status changes in Printavo. Check for a sandbox option, or add a hard guard preventing write-path tests from running against any other order ID.
- **Runbook / bus factor.** The platform now replaces 11 apps and is understood by one person. A short operational runbook (what breaks, how to tell, how to recover, how to roll back a bad sync) is worth more than any single new module.

---

## Summary

Build #44 as planned. Fold in: shared guardrail/audit modules, `effective_date` on KB entries plus the "source material is never canonical" rule, Pattern B verdict criteria, structured accuracy scoring. Schedule offsite backups independently and soon.
