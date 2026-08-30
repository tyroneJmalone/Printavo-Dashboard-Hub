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
| `create_quote_draft` | **Action.** Creates a Hub quote *draft* from plain English; returns a review link. Never touches Printavo. | none |

Hard boundaries, by design:

- No tool reads email/correspondence content.
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
3. Missive will list the six tools. Ask its AI something like "what's the
   status of order 22133?" in a conversation to verify.

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

## Validation: Pattern A vs Pattern B (Missive)

Missive can use context two ways; we measure before choosing a default:

- **Pattern A** — staff ask the Missive AI questions and write replies
  themselves.
- **Pattern B** — Missive AI drafts replies with context prefetched into a
  context note.

Procedure: run both for a comparable week of real conversations. For each
AI-assisted conversation, score in AI Connections: fact accuracy
(correct / wrong_fact / wrong_customer / missing_data) and usage outcome
(used / accepted / edited / rejected / ignored).

Pass criteria for Pattern B (from the Task #44 plan review):

- ≥95% of sampled conversations show the context note posted **before** the
  draft reply exists (ordering rule holds).
- Drafts demonstrably use note content (spot-check: facts in the draft trace
  to the note, not hallucination).
- Fact accuracy from scored audit events ≥ Pattern A's accuracy.

If Pattern B fails either rule, default to Pattern A and revisit.

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
