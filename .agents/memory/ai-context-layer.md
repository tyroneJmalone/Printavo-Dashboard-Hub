---
name: AI context layer architecture
description: Consumer-agnostic design rules for the Hub's AI context/knowledge layer
---

The context layer is deliberately NOT Missive-specific. One core service, many thin doors.

**The rule:** All context/knowledge logic (customer matching w/ confidence, Printavo fact lookups, knowledge search, audit logging) lives once in a protocol-independent core. Consumers connect through thin adapters only: an MCP endpoint (assistant platforms), a key-authed REST API (Zapier/JustCall/chatbots), and direct internal calls (Hub modules). Never put business logic in an adapter.

**Per-consumer credentials + two trust tiers:** each consumer gets its own token, scope list, rate limit, and audit trail. Internal tier (staff-facing: Missive, Hub, internal Zapier) may see any customer's data; external tier (customer-facing: chatbot, JustCall answering customers) may only see the verified caller's own data + public knowledge. External-tier consumers are future work, but the scope model ships from day one.

**Why:** Tyler (Aug 2026) explicitly wants the layer usable across chatbot, JustCall virtual agent, Missive, Zapier, Hub modules, and future platforms — "build for the now and the future, staying nimble." A Missive-shaped design would force a rewrite per platform. Knowledge sources he plans to feed: website content, Google Docs, other company data.

**How to apply:** When building or extending Task #44-era work, add capabilities to the core and expose them through existing doors; never build a feature that only one protocol can reach. Mailbox/correspondence content stays out of ALL doors (per-staff ACLs can't survive shared consumer credentials). Writes remain human-confirmed via existing draft/CONFIRM pipelines.

**Built Aug 2026.** Stateless per-request MCP transport (no session ids, JSON responses on) is what makes the MCP door work for both curl and assistant platforms — don't switch it to session mode without a reason. Docs for connecting platforms + the Pattern A/B validation procedure: docs/ai-context-layer.md.

**KB editorial invariant (review-caught twice):** editing ANY AI-visible field of an approved knowledge entry — title, body, category, tags, effective/expires — demotes it to draft for re-approval, with NO bypass flag ("cosmetic edit" is a claim review exists to verify). Only staff-only source breadcrumbs are exempt. Category/tags are easy to forget because they feel like metadata, but they drive retrieval.
