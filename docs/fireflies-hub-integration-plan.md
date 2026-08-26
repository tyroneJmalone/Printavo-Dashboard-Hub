# Fireflies → Printavo Hub Integration Discovery

**Status:** Deferred for later review  
**Discovery date:** August 25, 2026  
**Current Fireflies access:** Business plan; Team Admin  
**Implementation started:** No

## Goal

Create a quick-access Fireflies area inside the Printavo Hub so authorized staff can review meeting notes, summaries, insights, action items, transcripts, and AskFred conversations without separately navigating the Fireflies interface.

Meetings should be linkable to:

- Chipply stores
- Printavo customers
- Printavo quotes and invoices
- Hub collections
- moMINTum members/customers

The longer-term opportunity is a unified customer correspondence timeline combining email, meetings, and eventually calls.

## Confirmed Fireflies API capabilities

Fireflies exposes a GraphQL API that can support a native Hub interface.

### Meetings and transcripts

The API can provide:

- Meeting title, date, duration, organizer, participants, and attendees
- Fireflies transcript and meeting links
- Speaker-separated transcript sentences with timestamps
- AI summaries, keywords, and action items
- Sentiment, speaker metrics, and other meeting analytics
- Fireflies AI App outputs
- Audio and video URLs
- Channels and team-user information

The transcript list supports filters including keyword, date range, host, organizer, participant, user, ownership, and channel. Results are paginated with a maximum of 50 meetings per request.

Audio, video, and meeting analytics require Pro or higher. The current Business plan qualifies. Video still depends on video recording being enabled for the meeting.

### AskFred

AskFred is available through the public GraphQL API. The Hub can:

- Create a new AskFred thread
- Ask about a single meeting
- Ask across meetings using date, participant, organizer, channel, or transcript filters
- Continue a thread with follow-up questions
- List and reopen the authenticated Fireflies user's threads
- Request Markdown or plain-text responses

This enables a native Hub AskFred panel; it does not need to be an embedded Fireflies page. AskFred consumes Fireflies AI credits, so the Hub should expose credit-related failures clearly.

### Webhooks

Webhooks V2 supports:

- `meeting.bot_joined`
- `meeting.transcribed`
- `meeting.summarized`

Webhook requests are signed with HMAC-SHA256. The Hub endpoint must validate the signature and return a successful response within ten seconds. A periodic reconciliation job should still recover missed events.

### Sharing

The API can share a meeting with up to 50 email addresses and can set an optional expiration period. Sharing requires the meeting owner or a sufficiently privileged team administrator.

### Published rate limits

- Free: 50 requests per day
- Pro: 500 requests per day
- Business and Enterprise: 60 requests per minute

The current Business plan is suitable for a synchronized dashboard, provided ingestion is incremental rather than repeatedly crawling all meetings.

## Important account-access limitation

The current account is **Business + Team Admin**, not Enterprise + Super Admin.

A normal API key follows the meetings and team assets visible to its Fireflies user. Team Admin status does not guarantee privacy bypass across every teammate's private meetings. Enterprise Super Admin is the documented route for reliable team-wide visibility and team-wide webhook administration.

Therefore, do not assume that one central key covers the entire front-end team. Before choosing the final identity model, run a read-only visibility audit and compare API results against meetings known to belong to each front-end employee.

Possible outcomes:

1. **Central connection is sufficient:** use one server-side Fireflies connection owned by the Team Admin.
2. **Channel/sharing policy is sufficient:** automatically share relevant meetings into a team channel visible to the integration owner.
3. **Coverage remains incomplete:** connect each participating staff member's Fireflies account separately.
4. **Enterprise becomes justified:** consider it only if its Super Admin visibility materially simplifies the integration.

## Recommended product shape

### Meetings dashboard

- Recent meetings
- My meetings and team-accessible meetings
- Unlinked meetings
- Meetings needing follow-up
- Search by title, customer, attendee, or transcript keyword
- Filters for owner, participant, channel, and date
- Summary and action-item previews
- Badges for linked Hub entities

### Meeting detail

- Summary and keywords
- Action items
- Participants and attendance
- Speaker transcript
- Meeting analytics
- Audio/video and original Fireflies links
- Suggested and confirmed Hub links
- AskFred panel for the current meeting

### AskFred

- Ask about the selected meeting
- Continue a contextual conversation
- Optionally ask across meetings linked to one customer
- Preserve/reopen the Fireflies user's AskFred threads
- Show AI-credit errors rather than silently falling back

### Customer correspondence

Extend the customer correspondence experience to combine:

- Gmail threads
- Fireflies meetings
- Future JustCall calls

Automatic matching should suggest links; staff should be able to confirm, change, or suppress incorrect matches.

## Data ownership and boundaries

- Store all Fireflies synchronization state and entity links in new Hub-owned additive tables.
- Never add Fireflies-owned state to synchronized `pv_*` Printavo mirror rows.
- For moMINTum, keep external meeting references in Hub-owned tables rather than changing the shared live moMINTum schema.
- Keep Fireflies API access on the server; never expose the API key to browser code.
- Configure the key through Replit's secure Fireflies connector or workspace secrets flow. Never paste it into chat or commit it.
- Staff-authenticated users may view the meeting workspace according to the chosen visibility policy.
- Reserve integration configuration, destructive actions, and broad sharing controls for Hub admins.

## Recommended synchronization model

Use a hybrid local mirror:

- Store meeting identity, metadata, summary, action items, attendees, analytics, links, and matching state locally.
- Fetch or cache full speaker transcripts according to the final search/privacy requirements.
- Use `meeting.summarized` as the primary ingestion event.
- Reconcile periodically to recover missed webhooks and discover meetings that predate the integration.
- Make every ingestion path idempotent.
- Do not introduce a duplicate scheduler if an existing API-server scheduler can own the work.

This gives the Hub fast lists, matching, reporting, and customer timelines without requiring every page load to call Fireflies.

## Proposed phases

### Phase 0 — Read-only visibility audit

Securely connect the Team Admin API key and determine:

- Which users and channels are visible
- Which meetings owned by each front-end employee are visible
- Whether summaries, action items, transcripts, analytics, audio, and video are accessible
- Whether AskFred can query all meetings expected to be in scope
- Whether API results match the Fireflies interface closely enough for one central connection

Do not mutate or share meetings during this audit.

### Phase 1 — Read-only dashboard and manual linking

- Meeting list, search, and filters
- Meeting detail
- Manual links to supported Hub entities
- Fireflies deep links
- Staff access with admin-only integration settings

### Phase 2 — Incremental ingestion and matching

- Signed Webhooks V2 endpoint
- Periodic reconciliation
- Automatic customer/order suggestions
- Confirmation, reassignment, and suppression behavior modeled after email correspondence matching

### Phase 3 — Unified correspondence and action items

- Customer timeline integration
- Unlinked/follow-up queues
- Cross-meeting action-item views
- Communication-effort reporting

### Phase 4 — AskFred and broader meeting intelligence

- Current-meeting AskFred panel
- Customer-scoped questions across linked meetings
- Thread history
- Usage and AI-credit handling

AskFred may be moved earlier if it proves useful during the read-only pilot.

## Open decisions for the future session

- Does the Team Admin key actually see all desired front-end meetings?
- Are all Fireflies users in one workspace and using shared channels consistently?
- Which staff roles may view which meetings?
- Does “link to moMINTum” mean a member, a list, a task, or more than one entity?
- Should full transcripts be stored locally, cached temporarily, or fetched on demand?
- How long should meeting content be retained in the Hub?
- Should action items remain read-only or create moMINTum tasks in a later, separately reviewed write phase?
- Should meeting sharing remain Fireflies-only, or should the Hub eventually expose controlled sharing actions?

## Official documentation reviewed

- <https://docs.fireflies.ai/getting-started/introduction>
- <https://docs.fireflies.ai/fundamentals/authorization>
- <https://docs.fireflies.ai/fundamentals/limits>
- <https://docs.fireflies.ai/fundamentals/super-admin>
- <https://docs.fireflies.ai/graphql-api/query/transcripts>
- <https://docs.fireflies.ai/graphql-api/query/transcript>
- <https://docs.fireflies.ai/schema/transcript>
- <https://docs.fireflies.ai/askfred/overview>
- <https://docs.fireflies.ai/askfred/quickstart>
- <https://docs.fireflies.ai/graphql-api/mutation/create-askfred-thread>
- <https://docs.fireflies.ai/graphql-api/mutation/continue-askfred-thread>
- <https://docs.fireflies.ai/graphql-api/query/askfred-threads>
- <https://docs.fireflies.ai/graphql-api/query/askfred-thread>
- <https://docs.fireflies.ai/graphql-api/webhooks-v2>
- <https://docs.fireflies.ai/graphql-api/mutation/share-meeting>
