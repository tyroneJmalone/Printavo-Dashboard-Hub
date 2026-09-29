# Marketing module — discussion record

Recorded: September 29, 2026.
Status: **Deferred idea; documented for future consideration. No implementation, integrations, sending, or ad changes authorized.**

## Purpose and direction

Build a Hub marketing module that answers:
1. What is working?
2. What produces actual customers and repeat business?
3. What should the team try next?

The user proposed Google Analytics, Meta Ads, Constant Contact, and RB2B, then explicitly added Jotform. The recommendation is to connect marketing activity to Hub customers, opportunities, quotes, and orders rather than build another isolated dashboard of traffic and impressions. Everything below is a proposed direction, not approved scope.

## Sources and their roles

| Source | Useful information | Proposed use |
|---|---|---|
| Google Analytics 4 | Traffic sources, landing pages, engagement, tracked form submissions/key events | Identify channels and pages producing inquiries rather than visits alone |
| Meta Ads | Spend, reach, frequency, clicks, creative performance, platform-reported conversions | Compare campaigns, spot creative fatigue, and investigate expensive traffic that does not produce inquiries |
| Constant Contact | Sends, clicks, bounces, unsubscribes, opens and engagement history | Compare topics/audiences and connect attributable engagement to subsequent inquiries, quotes and orders |
| RB2B | Available identified visitor/company and visit information | Suggest potential prospects, returning customers and opportunity matches for staff review |
| Jotform | Inquiry submissions, form identity, submitted fields, available source/campaign information and explicit consent | Connect marketing traffic to a real inquiry and sales handoff |
| Hub / Printavo | Customers, opportunities, quotes, orders, repeat business and sales | Provide business outcomes the marketing platforms cannot independently verify |

Permissions, subscription entitlements, available fields, historical access, and API limits need validation before implementation. No connection was established during this discussion. RB2B documents webhook delivery and repeat-visitor options; its documentation warns that missed payloads may not be replayable. Do not promise complete historical recovery or universal visitor identification.

## Proposed pages

### 1. Weekly overview

Show ad spend, website inquiries, qualified opportunities, new customers, linked orders/revenue, and cost per inquiry/acquired customer where supported. Show date ranges, data freshness, connection failures, missing coverage and unknown attribution.

Accompany charts with short, evidence-backed explanations. Illustrative finding, not observed data:

> Traffic increased but quote requests stayed flat. Additional traffic mainly reached a landing page with a lower inquiry rate. Investigate the page and targeting before increasing spend.

Each recommendation must link to supporting measurements. The AI should explain computed results, not invent arithmetic, causation or statistically meaningful conclusions from small samples.

### 2. Channels and campaigns

Compare spend → visits → inquiries → quotes → wins → revenue across paid social, email, organic search, paid search and referrals. Group related ads, emails and landing pages into a cross-channel campaign, such as “Fall Team Stores.”

Questions this should answer:
- Are emails producing repeat orders or only website visits?
- Which ads lead to qualified inquiries and quotes?
- Which channels bring customers who return?
- How do team-store campaigns compare with company-apparel campaigns?
- Where in the inquiry-to-order process do opportunities stop progressing?

Keep Chipply outcomes separate from standard Printavo revenue. Chipply store sales and their production invoice shells must not be added together.

### 3. Audience and opportunities

Possible views: identified visitors not in Hub, returning customers, potential open-opportunity matches, companies with repeated relevant-page interest, and campaign engagement worth staff review.

Illustrative alert:

> A visitor appears to match an existing customer and returned to the team-store page. Review the identity match and customer history before deciding whether to follow up.

RB2B identity and browsing activity are signals, not proven buying intent. A company-domain match does not establish individual identity. Do not automatically enroll identified visitors in Constant Contact. Correspondence-derived context must obey the viewing staff member's current mailbox/thread permissions.

### 4. Strategy and experiments

Maintain a reviewable experiment list with evidence, hypothesis, owner, dates, budget if applicable, success measure and outcome.

| Opportunity | Example experiment | Measure |
|---|---|---|
| Relevant traffic, few inquiries | Simplify the inquiry form | Qualified inquiry rate |
| Email clicks, few quote requests | Test a clearer call to action | Requests from tracked links |
| Seasonal interest from returning customers | Send a relevant campaign to opted-in contacts | Opportunities and orders |
| Rising Meta frequency and declining results | Test new creative | Cost per qualified inquiry |

Preserve what was tried and what happened so the team does not repeatedly receive the same untested advice. Strategic recommendations should consider customer segments, seasonality and production capacity, not only more traffic or spend.

## Jotform: an early-phase priority

The intended connection is:

**Ad / email / search → website → Jotform → Hub opportunity → quote → order.**

Proposed capabilities:
- Unified inquiry inbox, labeled by form and purpose: quote request, team-store interest, contact request, etc.
- Source/campaign capture where supported. Campaign tags must survive the website and embedded-form journey; this does not happen automatically.
- Suggested existing-customer/new-prospect matches, with review before uncertain merges.
- Owner and next-action assignment; possible merch opportunity creation after review.
- Awaiting-action views and time-to-first-response measurement only where activity evidence is reliable.
- Lead-quality reporting by campaign: inquiries, qualified inquiries, quotes, won orders and linked revenue.
- Distinguish existing-customer service requests from new-business inquiries.
- Exclude spam and test submissions from marketing results.
- Deduplicate repeat delivery of a submission so it cannot create duplicate opportunities.
- Preserve explicit marketing consent separately from permission to respond to an inquiry. A quote request is not automatic newsletter consent.

Open design questions include which forms exist, how they are embedded, which fields/consent are captured, how the team currently responds, and how an inquiry should become an opportunity. None was resolved in this brainstorm.

## Additional tools worth evaluating

1. **Google Search Console:** high priority. Search queries/pages, impressions and clicks complement GA4. Find relevant queries with weak click-through, useful landing pages, and service-specific content opportunities.
2. **Google Ads:** if used, compare search-driven inquiries with Meta-driven inquiries and link paid-search costs to supported outcomes.
3. **Google Business Profile:** local-discovery reporting where accessible and review monitoring. Related to the separate review-request idea, not a prerequisite for sending review invitations.
4. **Microsoft Clarity:** a diagnostic companion for friction on low-converting pages through available recordings/heatmaps. Do not assume all its information belongs in Hub or is API-accessible. Review consent and sensitive-field masking.
5. **Call tracking:** CallRail or suitable existing phone-system reporting if phone inquiries are significant. Otherwise campaigns producing calls can appear ineffective.

Do not add services merely to fill a dashboard. Search Console and trustworthy inquiry tracking may provide more value than several new analytics subscriptions.

## Attribution and measurement guardrails

Keep three categories explicitly separate:

1. **Platform-reported:** a vendor reports a conversion under its own attribution settings.
2. **Hub-linked:** evidence connects a tracked inquiry to a customer, quote or order.
3. **Possible influence:** activity preceded an order, but causation is unproven.

Do not sum overlapping channel conversion counts as unique customers. Standardize campaign tags on ads and email links, capture sources on forms, retain an optional “How did you hear about us?” answer, and show Unknown/Unattributed totals. Account for the delay between lead creation and order conversion when comparing time windows.

Email opens are weakened by privacy features; clicks can include automated activity. Weight actual inquiries and orders more heavily. Do not claim true acquisition cost or ROI when costs, identities, attribution or profit inputs are incomplete. A linked sale alone does not prove incremental marketing impact.

## Proposed rollout

1. **Read-only reporting and inquiry foundation:** GA4, Meta, Constant Contact, Search Console and Jotform; weekly scorecard, channel views and initial inquiry capture. Jotform was promoted into this early stage after the user added it.
2. **Hub outcome linking:** improve campaign capture and customer/opportunity linkage; connect quotes/orders; introduce staff-reviewed RB2B signals.
3. **Strategy support:** evidence-backed weekly summaries, experiment tracking and planning around segments, seasons and capacity.
4. **Approved actions:** prepare audiences, campaign briefs, follow-up tasks and proposed budget changes. Require explicit approval before campaigns, enrollments or ad-spend changes.

Recommendation: begin with a weekly review page and campaign-to-sales view, with Jotform supplying the inquiry connection. The eventual weekly meeting should answer what changed, what produced business, what remains unknown, and the few experiments worth trying next.

## Sources consulted during brainstorming

- [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1)
- [Constant Contact campaign reporting](https://developer.constantcontact.com/api_guide/email_bulk_campaign_summary_report.html)
- [RB2B webhooks](https://support.rb2b.com/en/articles/8976614-setup-guide-webhook)
- [RB2B overview](https://support.rb2b.com/en/articles/8891294-what-is-rb2b-and-how-does-it-work)
- [Search Console reporting](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)

These establish reporting possibilities, not verified access to the user's accounts. Jotform's exact integration capabilities and Meta's current permissions/version requirements remain implementation-time checks.