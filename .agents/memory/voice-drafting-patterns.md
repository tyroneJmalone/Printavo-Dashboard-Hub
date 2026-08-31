---
name: Voice profiles & drafting patterns
description: Privacy and reliability rules for per-mailbox voice profiles and the Missive drafting webhook pipeline
---

**Privacy rule (Tyler-approved, absolute):** voice profiles are distilled
STRUCTURED TRAITS only — greetings, sign-offs, formality, phrasing habits.
Never message bodies or verbatim excerpts through any door; the only verbatim
material allowed is short greeting/sign-off forms. Profiles come from each
person's OWN sent mail, processed offline in the Hub.

**Why:** extends the standing "mailbox content never goes through the doors"
rule to voice matching without a special exemption. A completion review also
rejected relying on prompt instructions alone — enforcement must be
mechanical on both sides of the model.

**How to apply:** redact PII (emails, links, phones, amounts, long numbers)
from samples BEFORE any LLM call, and sanitize generated traits AFTER (drop or
scrub anything still carrying such content). Any new consumer of voice data
gets traits JSON only.

**LLM structured output:** clamp over-long arrays/strings to schema caps
before zod validation instead of failing the generation — cap overflow is a
quality nudge, not a correctness error.

**Webhook writes must be idempotent:** Missive delivery is at-least-once and
a shared secret allows replays, so every receiver dedupes on a durable unique
key (provider message id, else raw-body hash) BEFORE any Missive write. The
insert with a unique index is the gate.

**Single-writer email sync:** production always claims the heartbeat lock;
dev stands down while a fresh production heartbeat exists and auto-resumes if
production stops. Deployment must stay a Reserved VM or the scheduler idles.

**Pattern B pass criteria (pre-agreed):** context note lands before the
rule's draft in ≥95% of sampled conversations AND drafts demonstrably use
note content; ordering/latency auto-scored, note usage human spot-checked.
