# AI Context Layer

The Hub's "one core, many doors" context service: a single protocol-independent
tool registry that gives AI platforms verified company facts — synced Printavo
data plus the staff-reviewed knowledge base — through whichever door a platform
speaks. Missive is the first consumer; chatbots, JustCall, Zapier, etc. connect
the same way without new backend work.

## Architecture

```
                         ┌────────────────────────────┐
  Missive (MCP)  ──────▶ │  MCP door   POST /context/mcp
  Chatbot (REST) ──────▶ │  REST door  /context/v1/... │──▶ dispatch ──▶ tools
  Hub features   ──────▶ │  internal   executeContextTool()             │
                         └────────────────────────────┘                 ▼
                                                          synced Printavo tables
                                                          + knowledge_entries
```

- **Core** (`artifacts/api-server/src/lib/contextCore/`): tool registry
  (`tools.ts`), dispatch pipeline (`dispatch.ts`), fact queries (`facts.ts`),
  knowledge search (`knowledge.ts`), consumer token auth (`auth.ts`),
  short-TTL cache (`cache.ts`).
- **Guardrails** (`artifacts/api-server/src/lib/aiGuardrails/`): kill switch,
  audit trail, rate limiting, citation validation. Shared by the context layer
  and other AI features (they are not context-layer-specific).
- **Doors** (`artifacts/api-server/src/routes/contextDoors.ts`): MCP
  (Streamable HTTP, stateless) and REST. Both authenticate with per-consumer
  bearer tokens and funnel into the same dispatch path.
- **Admin** (`routes/aiConsumers.ts`, `routes/knowledgeBase.ts`): Hub pages
  "AI Connections" (admin) and "Knowledge Base" (staff).

### Dispatch pipeline (every call, every door)

kill switch → tool lookup → trust tier → scope → rate limit → zod validation
→ cache → handler → **audit** (every call lands in `ai_audit_events`, success
or failure, including cache hits).

## Tools

| Tool | What it does | Cache |
| --- | --- | --- |
| `lookup_customer` | Find customers by company/contact/email; returns candidates with exact/possible matchType | 30s |
| `get_customer_summary` | Profile + lifetime revenue, outstanding balance, order counts, 5 recent orders | 60s |
| `get_recent_orders` | Recent quotes/invoices with status, totals, due dates | 30s |
| `get_order_details` | One order by visual id: line items, sizes, decorations, payments | 30s |
| `search_knowledge` | Approved, currently-effective knowledge entries (verbatim body text) | 30s |
| `get_voice_profile` | Distilled writing-style traits for a team mailbox (greetings, sign-offs, formality, phrasing habits) — for voice-matched drafting | 120s |
| `create_quote_draft` | **Action.** Creates a Hub quote *draft* from plain English; returns a review link. Never touches Printavo. | none |

Hard boundaries, by design:

- No tool reads email/correspondence content. `get_voice_profile` returns
  structured style traits distilled offline from a teammate's own sent mail —
  never message bodies or excerpts (only short greeting/sign-off forms).
- No tool writes to Printavo. `create_quote_draft` only creates a Hub draft a
  human must confirm.
- All Printavo tools are **internal-tier only**. External-tier consumers
  currently get no tools — the tier exists so a future customer-facing
  consumer is structurally separated from day one.

## Trust tiers and scopes

Each consumer has:

- **tier** — `internal` (staff-facing platforms) or `external` (reserved).
- **scopes** — tool names the token may call; `["*"]` = all tier-eligible tools.
- **rateLimitPerMin** — default 60; in-memory sliding window (single-process
  server, so in-memory is deliberate; revisit only if the API server ever
  becomes multi-instance).

## Connecting a platform

1. Hub → **AI Connections** (admin) → *Create token*. Name it after the
   platform (e.g. "Missive"). Copy the token — it is shown exactly once
   (only a SHA-256 hash is stored).
2. Point the platform at a door on the **production** URL:
   - MCP: `POST https://<prod-domain>/api/context/mcp`
   - REST: `GET /api/context/v1/tools`, `POST /api/context/v1/tools/<name>`
     with JSON body `{ "arguments": { ... } }`
3. Auth header for both: `Authorization: Bearer hubctx_…`
4. Watch calls arrive on the AI Connections page; score accuracy as reviews
   happen.

### Missive (first consumer)

Missive's AI assistant supports custom MCP servers (Missive → Settings → AI →
Integrations/MCP). Setup (requires the Hub deployed to production and Tyler in
the Missive UI):

1. Create a consumer named `Missive` in AI Connections; copy the token.
2. In Missive's MCP integration settings add:
   - URL: `https://<prod-domain>/api/context/mcp`
   - Header: `Authorization: Bearer <token>`
3. Missive will list the seven tools. Ask its AI something like "what's the
   status of order 22133?" in a conversation to verify.
4. For Pattern A day-to-day use, save an assistant command (Missive → AI →
   saved prompts) such as: *"Look up this customer and our recent orders with
   the Hub tools, then answer my question / revise my draft using only facts
   the tools returned."* Staff invoke it per conversation.

### REST quick test

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://<prod-domain>/api/context/v1/tools
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"arguments":{"query":"acme"}}' \
  https://<prod-domain>/api/context/v1/tools/lookup_customer
```

## Knowledge base editorial rules

- Entries start as **drafts**; only **approved** entries within their
  `effectiveDate`/`expiresDate` window are served to AI.
- Editing an approved entry's content demotes it to draft for re-approval
  (unless the editor marks the change cosmetic).
- Source name/URL are staff-only breadcrumbs. **The reviewed entry text is the
  canonical fact** — source material is never served, so a stale source can't
  leak around review.

## Voice profiles (Pattern C's offline half)

Per-mailbox writing-style profiles live in `voice_profiles` (one row per
tracked mailbox) and are generated **inside the Hub** from that teammate's own
sent messages (`correspondence_messages` where `from_address` = the mailbox).
Quoted history is stripped and each sample is **PII-redacted before any model
sees it** — email addresses, links, phone numbers, dollar amounts, and long
numbers (order/tracking ids) are replaced with placeholders. An LLM then
distills structured traits: greetings, sign-offs, formality (1–5 +
description), typical length, sentence style, punctuation/emoji habits,
phrasing habits, tone descriptors, and imitation notes. Generated traits are
sanitized again on the way out (any trait still carrying an email/link/phone/
amount/long number is dropped or scrubbed) before being stored.

- Hub → **Voice Profiles** (staff): view every mailbox's traits, trigger a
  refresh (runs in the server process, usually <1 min).
- The `get_voice_profile` tool exposes the same traits on the internal tier.
  Raw sent mail never leaves the Hub; the only verbatim material in a profile
  is short greeting/sign-off forms.
- Refresh cadence: occasional/manual — style drifts slowly. Regenerate after a
  teammate deliberately changes how they write, or every few months.

## Drafting patterns (Missive)

Three ways Missive can use Hub context; we measure before choosing defaults:

- **Pattern A** — staff ask the Missive assistant questions; a saved command
  calls Hub tools (MCP) and answers / revises the draft.
- **Pattern B** — Missive rule fires a **webhook** on incoming email → the Hub
  posts a **context note** (customer, orders, balance, knowledge) on the
  conversation → a Missive **AI rule** drafts a reply from the note.
- **Pattern C** — the same webhook instead has the **Hub create the draft**:
  it combines the mailbox owner's voice profile with the context facts and
  creates a Missive draft via that teammate's own token, so Andrew's drafts
  sound like Andrew. A human always reviews and sends.

### Webhook setup (Patterns B & C)

Endpoints (public, HMAC-authenticated; management card on AI Connections):

- Pattern B: `POST https://<prod-domain>/api/missive/webhooks/context-note`
- Pattern C: `POST https://<prod-domain>/api/missive/webhooks/voice-draft`

1. AI Connections → *Missive webhooks* card → **Generate secret**.
2. In Missive: Settings → Rules → new rule on *Incoming email* (scope it to
   the mailboxes/labels in the trial) → action **Webhook** → paste the URL and
   the signature secret. Signatures are verified (`X-Hook-Signature`,
   HMAC-SHA256 of the raw body); bad signatures get 401 and are dropped.
   Deliveries are idempotent: each one is keyed by the Missive message id
   (falling back to a hash of the signed body), so an at-least-once
   redelivery or a replayed capture can never post a second note or create
   a duplicate draft.
3. Pattern B only: add the Missive **AI rule** that drafts a reply — instruct
   it to use the "Printavo Hub context" comment on the conversation.
4. Pattern C needs no AI rule: the Hub creates the draft itself. The mailbox
   owner needs a ready voice profile and a per-teammate Missive token
   (`MISSIVE_API_TOKEN_<NAME>`), because a draft's `from_field` must be an
   address that token can send as.

Every webhook lands in `draft_pattern_events` with timing (note latency,
draft-before-note detection, rule-draft polling at ~4 and ~12 min for B) and
shows up on the AI Connections *Drafting patterns* panel.

### Measurement procedure

Run all patterns over a comparable period of real conversations (Pattern A
freely; B and C on scoped rule filters). Scoring:

- **A and C**: score fact accuracy (correct / wrong_fact / wrong_customer /
  missing_data) and usage outcome (used / accepted / edited / rejected /
  ignored) on the audit events (`context_mcp` surface for A, the
  `voice_draft` tool events for C). For C, compare accepted-vs-edited against
  generic (non-voice) drafts.
- **B**: the panel computes note latency and note-before-draft ordering
  automatically; a human spot-checks each event's "draft used note content".

Pass criteria for Pattern B (pre-agreed in the Task #44 plan review):

- ≥95% of sampled conversations show the context note posted **before** the
  draft reply exists (ordering rule holds).
- Drafts demonstrably use note content (spot-check: facts in the draft trace
  to the note, not hallucination).
- Fact accuracy from scored audit events ≥ Pattern A's accuracy.

If Pattern B fails either rule, default to Pattern A and revisit. Record the
final recommendation in `docs/insights-log.md`.

## Production runbook

- Deployment is a **Reserved VM** (`deploymentTarget = "vm"` in `.replit`) so
  the sync scheduler, file mirror, and webhook receivers run 24/7 without the
  workspace being open. Autoscale would idle them between requests.
- **Single-writer rule**: the email-sync scheduler claims a heartbeat lock
  (`app_settings` key `email_sync_writer`). Production always claims it and
  stamps the heartbeat; a development workspace stands down while a production
  heartbeat is <30 min old and automatically resumes if production stops. No
  env flag to remember — publishing production silently quiets dev sync.
- Production needs the same secrets as dev (database, Clerk, Printavo,
  `MISSIVE_API_TOKEN` + per-teammate tokens, OpenAI). The webhook signature
  secret lives in the shared database, not env.
- After publishing, verify: `GET https://<prod-domain>/api/context/v1/tools`
  with a consumer token, and the workflow logs show "Sync scheduler started"
  plus writer-lock claims.

## Operational notes

- **Kill switch**: AI Connections → "Disable everything" (stored in
  `app_settings` key `ai_guardrails`, ~10s propagation). Every door fails fast
  with `CONTEXT_DISABLED`.
- **Revoke one platform**: AI Connections → Revoke (permanent) or Pause
  (reversible).
- **Caching decision**: short per-tool TTLs (30–60s) on read tools, in-memory,
  keyed by validated args. Facts come from the local synced DB, so caching is
  about absorbing chatty AI retry loops, not protecting Printavo. Actions are
  never cached.
- **Audit**: `ai_audit_events` keeps input (truncated), result summary,
  latency, error codes, plus human scoring fields. The Hub audit UI shows the
  last 100 events with a scored-accuracy percentage.
