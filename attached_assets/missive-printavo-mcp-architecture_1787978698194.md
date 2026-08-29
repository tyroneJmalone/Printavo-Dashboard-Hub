# Hub ↔ Missive ↔ Printavo: MCP Architecture Outline

**Purpose:** Give the Hub project (Notion-based knowledge/context layer) the ability to supply verified Printavo order/customer facts and Notion KB content to Missive's AI, without duplicating Missive's own inbox/drafting functionality.

**Core principle:** Missive owns triage, drafting, and sending. Hub owns verified facts, links, and safe reviewable actions. Hub is the single context layer behind multiple consumer surfaces (Missive now; JustCall voice and a customer chatbot later), not a one-off integration.

---

## 1. Confirmed constraints (verified against Missive's docs, Aug 2026)

- **Missive has two separate MCP directions.** "MCP integrations" (Settings > Integrations > MCP) let Missive's own AI assistant call *out* to external tools. The separate "Missive MCP server" lets an outside AI application call *into* Missive's own data. We only need the first direction for this build.
- **AI Rules cannot call MCP tools.** Missive's AI Rules engine only supports four fixed actions: *Add AI note*, *Create draft with AI*, *Add tasks with AI*, *Add label(s) with AI*. None of these reference MCP or external tool calls. MCP access is scoped to the interactive Assistant (chat / "Ask Missive AI"), not the automated rules engine.
- **Practical implication:** full automatic drafting with live Hub context is not currently possible via Rules. Build around the two supported patterns below instead.

## 2. Two supported integration patterns

**Pattern A — "Enrich this reply" (build first, most reliable)**
- A Missive AI Rule creates the initial draft automatically as it does today.
- A staff member runs a saved Assistant command (e.g. *"Check Hub for this customer and revise the draft using verified order info"*).
- The Assistant, via Hub's Custom MCP integration, pulls the relevant Printavo/Notion data and revises the draft.
- Fully supported today. No dependency on unconfirmed behavior.

**Pattern B — Automatic context note (build second, needs testing)**
- Missive sends Hub a webhook on new customer message.
- Hub identifies the customer/order and posts an internal **Add AI note** (or Missive API note) to the conversation with customer link, order status, balance, mockup links, and any match uncertainty.
- The AI Rule's **Create draft with AI** action then drafts using that note as conversation context.
- **Needs verification before relying on it:** whether the note reliably lands before the rule fires, and whether rule-generated drafts consistently read/incorporate notes. Treat as a spike, not an assumption.

Do not attempt a third pattern where Rules call MCP tools directly — not supported per Missive's docs as of this build.

## 3. Rollout phases

| Phase | Scope | Risk |
|---|---|---|
| 1 | Read-only Printavo + Notion KB access via Custom MCP, used through Pattern A | Low — no writes |
| 2 | Webhook-triggered context notes (Pattern B) | Medium — depends on rule/note timing |
| 3 | Safe, reviewable Hub-side writes: AI quote drafts, follow-up tasks, artwork/order-link suggestions | Medium — all outputs stay in draft/pending state, human approves |
| 4 | Feedback loop: track accept/edit/reject/correct-match rates per suggestion to improve prompts and matching | Low |

**Hard rule for all phases:** Hub-side AI never creates a live Printavo quote or sends anything externally. It creates a Hub AI Quote Draft; staff explicitly convert it in Hub/Printavo.

## 4. Layered architecture

```
Source systems           →   Hub context layer         →   Consumer surfaces
─────────────────────         ────────────────────           ──────────────────
Printavo (orders,             MCP orchestration,              Missive AI Assistant
invoices, mockups)            permission scoping,              (Pattern A / B)
Notion (Order Guidelines,     audit logging                   JustCall voice agent (future)
Customer FAQ, Internal Ops)                                   Hub team search (internal)
Fireflies / JustCall                                           Customer chatbot (future)
  (call context, future)
Jotform (quote/inquiry
  forms, future)
```

Hub does not duplicate source data wholesale — it calls out live (Printavo) or reads a curated, versioned copy (Notion KB) and returns structured, verified facts. Consumers never talk to source systems directly.

## 5. Printavo MCP tool set (Phase 1, read-only)

| Tool | Input | Returns |
|---|---|---|
| `find_customer` | email / name / phone | Matched customer(s) + confidence score |
| `get_customer_summary` | customer_id | Profile, order count, standing |
| `get_recent_orders` | customer_id, limit | Recent orders with status |
| `get_order_status` | order_id | Current stage, key dates |
| `get_invoice_details` | order_id | Line items, totals, dates |
| `get_payment_status` | order_id | Outstanding balance, payment history |
| `get_order_mockups` | order_id | Mockup/proof links |
| `get_customer_artwork` | customer_id | Saved artwork/bookmark links |
| `get_brand_standards` | customer_id or org_id | Brand standards doc/links |
| `build_customer_link` | customer_id | Direct Hub/Printavo URL |
| `build_order_link` | order_id | Direct Hub/Printavo URL |
| `create_quote_draft` | customer_id, product context | **Phase 3 only.** Creates a Hub AI Quote Draft, not a live Printavo quote |

**Design rules for every tool:**
- Return structured fields (not prose) — the consuming model quotes fields verbatim rather than paraphrasing figures/dates, to reduce hallucination risk.
- Scope every query to the specific conversation's contact — no open-ended "any customer" lookups from the Assistant.
- Every response includes a confidence/match-quality indicator when identity is inferred (see §7).

## 6. Notion KB as a parallel MCP source

Alongside Printavo, expose the Notion KB (Order Guidelines / Customer FAQ / Internal Ops — architecture already defined separately) via Notion's native MCP integration:
- **Missive Assistant / Hub team search** → full access to Order Guidelines + Internal Ops + Customer FAQ.
- **Any customer-facing surface (future chatbot, JustCall voice)** → hard-filtered server-side to Customer FAQ only. This filter belongs in the Hub tool layer, not left to model judgment.

## 7. Customer-matching logic (open item — needs explicit design before Phase 1 ships)

- Define a confidence threshold for `find_customer` matches (e.g., exact email match = high confidence; name-only or shared-inbox cases = low confidence).
- Below threshold: return "no confident match" rather than a best guess — never let the Assistant silently pick a customer.
- Multiple-match cases: return all candidates with distinguishing info (last order, org name) so staff can pick, don't auto-select.

## 8. Security and governance

- **Least privilege:** Custom MCP credentials scoped to what Hub tools actually need — no broad Printavo admin access.
- **Audit trail:** log every Hub tool call (what was queried, by which conversation, what was returned) from Phase 1 onward — cheaper to build in now than retrofit for Phase 4 feedback tracking.
- **No unreviewed writes:** anything that creates/modifies a record (quote drafts, tasks, link suggestions) stays in a pending/draft state requiring explicit human approval, per §3.
- **Trust boundary on Custom MCP setup:** Missive's own docs warn it doesn't control what a connected MCP integration does with data it receives — since Hub's MCP server is your own build, this is fully in your control, but document the auth method (bearer token recommended for a first-party server) for the Replit agent.

## 9. Future / not in this build

- **JustCall MCP / native Notion KB integration:** listed as "coming soon" by JustCall as of last check — do not build Phase 3+ around it until confirmed shipped. Manual export remains the fallback.
- **Fireflies and Jotform as context sources:** planned as read-only inputs into `get_customer_summary`-style aggregation, not separate consumer-facing tools, to avoid Missive/JustCall having to chain multiple single-source calls.
- **Google Workspace MCP:** for internal team search only, via a vetted third-party server (no official Google-published MCP server exists yet) — kept fully separate from the customer-facing Printavo/Notion KB layer.

## 10. Immediate next steps for the Replit agent

1. Stand up the Printavo MCP server with the Phase 1 read-only tool set (§5), bearer-token auth.
2. Connect it to Missive as a Custom MCP integration; validate Pattern A end-to-end with a real conversation.
3. Build the customer-matching confidence logic (§7) before any tool returns a customer record.
4. Add logging at the tool-call level (§8) from day one.
5. Only after Pattern A is stable: spike Pattern B (webhook → note → rule timing) to see if it's reliable enough to promote to production.
