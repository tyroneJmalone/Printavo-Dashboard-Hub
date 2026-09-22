# PrintScope — Deferred Features & Integrations

**Handoff notes for Replit. Nothing here is being built now.**
Companion to `printscope-phase0-findings.md` and `printscope-rules-v2.csv`.

This document exists so that decisions made during v1 don't foreclose these.
Each section says what it is, why it matters, and — importantly — **what v1 must
not do** if it wants to stay compatible.

---

## Section A — The hot folder is really Printavo

### The correction

The build plan described a watched folder. That framing was wrong, and it's worth
saying why plainly, because it changes an architectural decision in v1.

**A folder gives you a file with no context. A Printavo invoice gives you the
file *and* the job.**

The relational rules — plate count vs ordered colours, underbase required on
darks, print size vs location preset — all need `job_context`: ink count, garment
shade, print location, quantity. The plan assumed an operator would type that
into an intake form. Printavo already holds it.

So the hot folder was always a degraded version of the Printavo integration, and
the intake form is a fallback for files that arrive outside a job, not the
primary path.

### How Mint's workflow actually runs

- Invoices are created in Printavo: approvals, payments, scheduling, production
  notes all live there
- **seps.io attaches proofs to invoice line items** — for the customer and for Mint
- **seps.io attaches output/production files to the invoice** — the separations
  PrintScope inspects
- Mint already runs a **shop management Hub** (Replit app) integrated with the
  Printavo API in many ways

### Architecture: PrintScope owns its own Printavo connection

> ⚠️ **Superseded by Section G — read that instead.** For Mint, the Hub keeps the
> Printavo connection and pushes job context to PrintScope; a direct per-tenant
> connector stays an unbuilt adapter behind the same interface. PrintScope is
> still a separate service, but it does not poll Printavo.

```
Printavo (per-tenant)  ──poll/webhook──►  PrintScope  ──►  verdict
                                              │              │
                                        job context     → Printavo note
                                     (colours, garment,  → digest email
                                      location, date)    → API for the Hub
```

The Hub becomes a **consumer** of PrintScope, not its front door — embedding
views and reading verdicts over PrintScope's API. Mint's instance is simply
tenant #1.

**What this means for v1 — the one thing that must not be got wrong:**

> PrintScope's ingestion endpoint takes **a file plus a `job_context` object**,
> from any caller. Manual upload, hot folder, and the Hub are three callers of
> one contract. `job_context` already has a `source` field in the schema
> (`"manual"` | `"printavo"`) — keep it, and never let the parser or rule engine
> reach for Printavo directly.

If v1 hardcodes an intake form as the only way context arrives, this becomes a
refactor instead of a new caller.

### Implementation notes for whoever builds it

- **Verify Printavo's API surface first.** Confirm which API version the Hub uses
  (fastest source of truth for what works) and whether Printavo exposes webhooks
  for attachment events. If it does, use them. If not, poll invoices filtered by
  production date window — cheap, and the date window is a natural scope (you only
  care about jobs approaching the floor).
- **Write the watcher as "for each connection, poll"** even while there is exactly
  one connection. Per-tenant cursor, per-tenant backoff, per-tenant rate budget.
  Retrofitting a single-connection poller into a multi-tenant one is the kind of
  rewrite that stalls a launch.
- **Attachment scope differs.** Proofs sit on *line items*; production files sit
  on the *invoice*. The watcher polls invoice-level attachments. Don't assume one
  endpoint returns both.
- **Idempotency by content hash, never filename.** seps.io resends
  `#22499 F OUTPUT.ai` as a revision. Same name + different hash = new revision,
  which is a feature (see B1), not a duplicate.
- **Wait for the write to settle** on any folder-based path — poll size and mtime
  until stable ~5s. A 2 MB `.ai` arriving over a share is not atomic.
- **Write the verdict back into Printavo** as a production note on the invoice.
  That puts the result where the team already looks, instead of in a fourth app.
- **Replit needs Always-On / Reserved VM** for the worker and scheduler. A sleeping
  app answers no webhooks.
- **Do not auto-move or auto-release during the pilot.** Notify only until the
  measured disagreement rate is near zero. Automating an unvalidated rule set
  just delivers wrong answers faster.

---

## Section B — Screen department forecasting

### B0. The mesh tally (as requested)

Because the swatch naming convention is `{head}-{mesh}-{ink}`, **every separation
file already declares its own screen requirements.** No extra data entry, no
guessing.

Across a date range or a batch:

```
160 mesh — 24      ← underbase, always 160 in the sample files
200 mesh — 33
230 mesh — 44
```

Two sources, same output:
- **Batch mode** — assess every file in a folder, tally
- **Printavo mode** — pull invoices by production date, tally their attached
  output files

Printavo mode is the useful one, because it answers *"what does next week need?"*
rather than *"what's in this folder?"*

### B1. What to tally beyond mesh

The swatch name carries more than mesh, and the file carries more than the name:

| Also available | Why the screen dept cares |
|---|---|
| **Head count per job** | Press assignment — a 6-colour job can't run a 4-head |
| **Head positions used** | 22834 uses heads 1, 4, 5, 6, 10 — gaps affect setup |
| **Underbase present** | Always head 1 / 160 mesh; adds a screen and a flash |
| **Ink coverage % per plate** | Rough ink consumption when combined with quantity |
| **Art dimensions** | Frame size selection |

### B2. Inventory reconciliation — where this gets genuinely useful

A tally is information. A tally *against what you own* is a decision.

> Tuesday needs 44 × 230 mesh. You have 38 in rotation with a 1-day reclaim
> turnaround. Short by 6.

That requires one small table — frame counts by mesh, and average reclaim
turnaround — and turns the forecast into a capacity warning. This is the version
worth building; the raw tally is the stepping stone.

### B3. Screen reuse detection

Hash the plate geometry (the extractor already walks every path). If an incoming
plate's geometry hash matches one from a previous job at the same mesh, **you may
already have that screen burned.**

> Head 5 / 230 / `Grey 428 C` — geometry matches invoice 21883, burned 18 days ago.

Repeat customers reorder constantly. Screens are emulsion, labour, and reclaim
time. This is the single highest-dollar idea in this document and it costs almost
nothing on top of work v1 already does.

### B4. Analytics that fall out for free

Once inspections are stored: mesh demand over time, average colours per job,
underbase frequency, screens per job trending, seasonal load. Useful for
capacity planning and for deciding whether a mesh count is worth stocking.

---

## Section C — Other ideas worth considering

Ranked by value-to-effort, and every one of them is grounded in something already
visible in the four sample files.

**Reviewed with Tyler.** C2 is promoted to build-early. C1 is reframed. C3 is
dropped, with the reasoning kept so it isn't re-proposed.

### C1. Revision diff — reframe: it's a screen-saving feature, not a QC one

Originally pitched as "did seps.io fix what we asked?" That scenario doesn't
exist at Mint yet — **because the tool that creates it doesn't exist yet.** The
reject-and-resend loop is something PrintScope introduces. So as a QC feature
it's genuinely premature: revisit after the tenth file has been sent back.

**The version that pays today** is one that already happens: a client asks for a
change after screens are made, and a new output file lands on the same invoice.
The question the screen department needs answered is *which screens survive.*

> **#22499 rev 2** — Under and Black plates unchanged (geometry hash match).
> `5-230-Grey 428 C` changed. **Reburn 1 of 3 screens.**

That's the same geometry hashing as screen reuse (§B3), pointed at two revisions
of one job instead of two different jobs. Build them together — one hash, two
features. Emulsion, labour and reclaim time are the return.

### C2. Production digest email ★★ build this early

Supersedes the printed press setup sheet. Mint prints as little as possible, and
the whole team works from iPads.

**The problem it solves:** seeing what's coming currently means clicking in and
out of each job on the Printavo calendar, one at a time. The digest collapses
that into one scan.

**Shape:** a daily or weekly HTML email, in-body (not an attachment — an
attachment means opening a second app on an iPad). Content per job:

```
#22499   CMC Kickball            Tue 16 Sep   ·  48 pc  ·  Navy 50/50
  head  1  ·  160 mesh  ·  Under
  head  5  ·  230 mesh  ·  Grey 428 C
  head 10  ·  230 mesh  ·  Black
  [proof thumbnail]
```

Topped with the week's mesh tally (§B0) and a job count, then jobs in production
date order.

**The swatch names already are the press setup** — head, mesh and ink, in order,
parsed straight from the file. Nobody has to transcribe anything.

**Build notes:**

- **Two audiences, one email.** Screen dept wants it grouped by mesh (what to
  burn); press operators want it by day (what to set up). Summary block on top,
  job list below, rather than two separate emails.
- **Expandable thumbnails:** email clients don't run JavaScript, and the CSS
  checkbox hack works in Apple Mail but breaks in Gmail and Outlook. Since the
  team is on iPads it would *probably* work — but don't rely on it. Embed
  thumbnails inline at a readable size and link each one out to a full-size view.
  The robust pattern is: **the email carries the full summary; a hosted digest
  page carries the interactivity.**
- **Host the images, never base64 them.** Gmail clips messages over ~102 KB of
  HTML, and a dozen inline proofs would blow that instantly.
- **Resend is already in the Breezy stack** — no new dependency.
- **Ownership:** PrintScope, not the Hub. It holds both halves — the Printavo
  connection (customer, date, garment, quantity, proof) and the separation data
  (ink, mesh, head order) — so it composes and sends. Every decorator running
  PrintScope would want this digest, which is the test for whether something
  belongs in PrintScope or in the Hub.

**Sequencing — worth noting:** this needs only the swatch-name parser (~30 lines),
not the rule engine or any verdict logic. **It could ship well before the rest of
PrintScope**, deliver value immediately, and get the team used to the tool before
anything starts issuing pass/fail judgements.

### C3. Proof vs. output drift check — dropped as originally framed

**Recorded so nobody re-proposes it.**

The original idea was to compare print dimensions between the approved proof and
the output file. **That does not apply to how Mint works**, for deliberate
business reasons:

- Mint does not notate print dimensions on proofs. Garment details or size
  breaks occasionally force minor adjustments, and notating dimensions would mean
  re-approving those every time.
- Clients don't read the dimensions anyway. They say "it's too small" if they
  think it's too small, whether or not the size was stated. The practical choice
  is to fight it or fix it, and Mint fixes it — usually after pointing out that
  the detail was communicated.

So a dimension check would police a number Mint intentionally doesn't commit to.
Skip it.

**What survives, only if it's a failure actually seen in practice:** comparing
the *artwork* between the approved proof and the output file to catch an output
built from a **superseded proof revision** — client approves v3, seps.io builds
from v2. That's version control, not dimensions, and it's dimension-independent.
Worth building only if that has actually happened. If it hasn't, don't spend the
time.

### C4. Mesh vs. detail rule ★ nobody else can do this

The swatch name carries the mesh. The file carries stroke widths and halftone
detail. Cross-reference them:

> `5-230-Grey 428 C` carries a 0.22 pt stroke — under our minimum for 230 mesh.

A generic preflight tool can't check this, because it doesn't know the mesh —
your naming convention is what makes it possible. Add `min_stroke_pt` per mesh to
the rule profile.

### C5. Garment colour from Printavo closes the relational rules

`UNDERBASE_REQUIRED_DARK` needs garment shade. Printavo line items carry the
product and colour. Map product colours to light/dark once, and the rule that
needed an operator to answer a dropdown answers itself — removing the last place
where a wrong human answer produces a false pass.

### C6. Convention drift monitoring

The samples already show drift: 19038 came from Illustrator 29.8 with **ICCBased**
alternates, the others from 30.x with **DeviceRGB**. Silent upstream changes are
what break parsers months later.

A quiet dashboard — new swatch names seen, new mesh counts, Illustrator versions,
first-time-seen structures — turns a future outage into a Tuesday notification.

### C7. Ink consumption estimate

Coverage % per plate × print area × quantity from Printavo ≈ ink usage. **Be
honest about precision:** this ignores mesh, EOM, squeegee pressure and off-contact,
so it's a trend and ordering aid, not a cost model. Label it as an estimate in the
UI or it will be quoted back as fact.

### C8. White-ink truthfulness in the viewer

Deferred from the viewer build, recorded so it isn't lost: on a separation plate,
white means *no ink*, but it currently renders as opaque white. Viewing an
underbase plate alone, the knockouts read as printed white rather than bare
garment. Harmless while the base sits at the bottom of the stack; worth fixing if
plate-in-isolation view ever needs to be literally truthful.

### C9. Black-knockout rule

Also from the viewer build: the underbase plate carries 37 white knockout shapes
matching the 37 black fills exactly. Black isn't merely un-choked — it's actively
**removed** from the base. That's independently checkable, and a file where the
base runs full under black would lay white ink under black for no reason. Not yet
in `printscope-rules-v2.csv`; add as `UNDERBASE_KNOCKOUT_UNDER_BLACK`.

---

## Section D — What v1 must preserve

The short list of decisions that keep all of the above cheap later.

1. **One ingestion contract**: `(file, job_context)` from any caller. Keep
   `job_context.source`.
2. **Store the facts JSON permanently**, even after artwork is purged. C1, B3, B4
   and C6 all read from it. It's small; keep it forever.
3. **Rules stay data, not code** — the `rules` table with stable `code` slugs,
   shared with the future Illustrator automation.
4. **Hash everything**: file content hash for idempotency, plate geometry hash for
   screen reuse. Both are cheap at parse time and impossible to backfill once
   artwork is purged.
5. **Never let the rule engine call Printavo.** Context arrives as data; the
   engine stays a pure function.
6. **PrintScope owns its own Printavo connection, per tenant** (§E2). The Hub is
   a consumer over PrintScope's API, not its front door.
7. **No Mint convention in code** — layer name, swatch regex, choke value and
   underbase marker all live in the rule profile (§E1). This is the one that
   turns into a parser rewrite if it's got wrong.
8. **`org_id` on every table from the first migration**, even with one org (§E3).

---

## Section E — Productisation: PrintScope is standalone, not a Hub module

Mint builds and tests PrintScope as an internal tool. But the intent is that it
later becomes available to other decorators with their own connections — their
own Printavo accounts — the way the Breezy tools work. It sits **alongside** the
Hub like Mint Bucks, Momintum and the Reorder Portal, not inside it.

Other PrintScope users will have no Hub. That single fact drives everything below.

### E1. The two Phase 0 discoveries are Mint conventions, not facts

This is the most important consequence and it is easy to miss.

The two findings that made the rule set work are **both specific to how Mint and
seps.io operate**:

| Discovery | Mint's version | Another shop |
|---|---|---|
| Layer scoping | artwork lives on `PASTE ART HERE` | different name, or no layer discipline at all |
| Swatch structure | `{head}-{mesh}-{ink}` | any convention, or none |
| Choke spec | 0.75 pt centre, zero-ink stroke | different value, different mechanism |
| Underbase marker | named `-Under`, Rhodamine Red proxy | different name, different proxy colour |
| Registration swatch | `All` | usually `All`, but don't rely on it |

**None of these may be hardcoded.** Each belongs in the rule profile as
configuration, with Mint's values as the seed template. The naming regex
currently sitting in `printscope-rules-v2.csv` is a *Mint profile value*, not a
constant — and the layer name must become a `layer_scope` setting resolved per
org rather than the literal string it is today.

If v1 hardcodes either one, the product version is a rewrite of the parser's
control flow, not a settings screen.

### E2. Per-tenant credentials from day one — the BreezyMock lesson

BreezyMock's distributor services use **app-level env vars** and are already
flagged as needing refactoring to per-user credential storage. That is precisely
the mistake available here, and it is cheaper to avoid than to remediate twice.

- `printavo_connections` table keyed by org, credentials encrypted with
  **Fernet** (the existing Breezy standard for third-party credentials at rest)
- No Printavo token in Replit Secrets beyond a bootstrap
- Token refresh, revocation and connection-health state modelled now, even with
  one row in the table

### E3. Revisit the v1 tenancy decision

The earlier call was **internal single-tenant**, with Breezy-isation deferred.
Given this, the middle option — *internal UX, multi-tenant schema* — is now the
better bet and is worth re-deciding.

Concretely: keep the simple single-user experience (no auth complexity, no
Stripe, no org switcher), but put `org_id` on `rule_profiles`, `approved_spots`,
`spot_aliases`, `inspections`, `rule_results` and `printavo_connections`, with a
default org for Mint. `rule_profiles` was already designed to be per-profile, so
the schema is half-way there.

Adding a column now is minutes. Backfilling `org_id` across a year of
inspections, and re-scoping every query that assumed one tenant, is a migration
with a data-integrity risk attached.

**The UX stays single-tenant in v1. The schema should not.**

### E4. Onboarding a new shop — and a slick way to do it

A new decorator's first run needs: connect Printavo, declare the swatch naming
convention, name the artwork layer, set the choke spec, list mesh counts. That is
a setup wizard, and it reframes the admin UI (plan Phase 4) as *"define a profile
from scratch"*, not *"edit Mint's"*.

**The better version: infer the profile from sample files.** Ask a new shop to
upload five files they consider correct, then derive the naming pattern, layer
names, choke value and mesh counts from what's actually in them, and present it
for confirmation.

This is not speculative — it is exactly what Phase 0 did for Mint, by hand, from
four files. Automating it turns a multi-hour consulting conversation into a
five-minute onboarding, and it is a strong differentiator against buying a
PitStop seat and writing Action Lists yourself.

### E5. Not every shop outsources, and not every shop uses Printavo

- **Order system**: Printavo is one integration. Others use ShopWorks, Printavo
  competitors, or nothing. Keep `job_context` source-agnostic — it already has a
  `source` field — and treat the intake form as a first-class path rather than a
  fallback, since some tenants will never connect an order system at all.
- **Prepress source**: some shops do their own seps rather than outsourcing, so
  the tool becomes self-check rather than contractor-check. Same rules, different
  framing in the copy.

### E6. Open question: branding

Whether this ships as a Breezy product, under its own name, or as the separate
decorator-focused brand already planned post-BT launch is unresolved. It doesn't
block anything technical, but it does affect auth and billing reuse — sharing
Firebase Auth and Stripe with BT/BM is straightforward if it's Breezy-branded and
a larger decision if it isn't. Worth settling before Phase 7, not before Phase 1.

---

## Section F — Hub integration (resolved)

Supersedes the open questions in §A and §E. Based on the architecture recap from
the Replit agent.

### F1. How the existing modules actually integrate

Not iframes, and not APIs. The pattern is **ported frontend code plus
cross-application direct database access.**

| Module | Frontend | Backend |
|---|---|---|
| moMINTum | ported into Hub at `/momintum/` | Hub's `/api/momintum/*` reads and writes the **standalone app's live database** |
| Mint Bucks | native Hub pages at `/mintbucks/*` | Hub's `/api/mintbucks/*` reads and writes the **standalone Mint Bucks database** |
| Reorder Portal | separate customer frontend | uses the **Hub backend** and Hub-owned data |

Hub itself: React frontend, shared backend API, PostgreSQL holding synchronised
Printavo data plus Hub-owned records.

**PrintScope must not use this pattern.** It is the one decision here that is
expensive to reverse: a second application holding credentials to PrintScope's
database makes schema changes a two-app coordination problem, and makes tenant
isolation unenforceable the day a second shop exists — the Hub would be reaching
into a table containing another shop's inspections.

This needs stating plainly in the build instructions **because the house pattern
is the path of least resistance.** Both existing examples do it the other way.

**This is not new advice.** The Hub's own open architecture concerns already list
*"sister-app shared-database coupling with weak identity join keys"* as a known
problem. PrintScope is the chance not to add a fourth instance of it.

### F1b. Reconciling with "one core, many thin doors"

The Hub's stated architecture principle is that it is the single canonical
context layer and *no consumer surface maintains its own copy of data*. At a
glance, PrintScope owning its own database looks like a violation. It isn't, and
the distinction is worth having ready because it will come up:

- **A consumer surface** reads Hub data to display it. Those should not copy —
  that principle stands.
- **PrintScope is a source**, not a consumer surface. It *produces* data that
  does not exist anywhere else: inspection verdicts, plate geometry hashes,
  extracted facts. Nothing upstream owns those.

The principle is preserved by PrintScope **feeding the Hub once** — verdicts and
tallies over its API — exactly like Printavo does. What would violate the
principle is the Hub keeping its own second copy of inspection records, or
PrintScope mirroring Hub order data it should be asking for.

### F2. Good news: the API foundation already exists

The Hub project already maintains an **OpenAPI specification** and generates
client code and validation types from it. So "API-first" is not new
infrastructure — it is an existing pipeline PrintScope can adopt.

Worth keeping the distinction the brief draws: an OpenAPI *spec* is a
description; a *supported API* adds authentication, permissions, versioning,
documentation and compatibility commitments. PrintScope needs the first
immediately and the second only when a second shop connects.

"Open API" never means unauthenticated. A documented partner API stays private
and authenticated.

### F3. What goes natively in Hub, and what does not

The brief offers linked-standalone vs native-Hub screens and recommends a hybrid.
For PrintScope, be more specific than that:

**Stays in the standalone app — do not port:**
the plate viewer. Vector plate rendering, zoom/pan, per-plate toggles and the
opacity compositing are a heavy, specialised visual surface. Porting it into Hub
means maintaining it twice, which is exactly the moMINTum trap.

**Goes natively into Hub — small and cheap:**
- verdict chip on a job ("Release" / "Hold" / "3 flags")
- the week's mesh tally
- a "files awaiting review" count
- link out to the standalone app for the actual inspection

That split keeps one complete interface rather than two partial ones.

### F4. Identity: do not inherit email-based mapping

The moMINTum integration maps members **by email** rather than by shared
authentication-provider user IDs. That is fragile — emails change, and they are
not a safe join key across systems.

PrintScope should use **Firebase Auth UIDs**, already the Breezy standard, and
keep two things separate:

- **Hub → PrintScope machine auth** — a scoped, revocable service credential per
  connected shop
- **Human SSO** — a Hub user clicking into PrintScope carries an identity

API credentials alone are not user sign-in. The brief is right to separate these,
and it is usually where these integrations get awkward.

### F5. Which of the brief's requirements apply to v1

The brief's technical checklist is written for a product that performs
**transactions**. Mint Bucks is money: idempotency, audit trails, duplicate
protection and a single authoritative service are all essential there.

PrintScope is **read-only analysis of files.** It has one meaningful write — an
inspection record — no balances, no financial operations, no customer-facing
surface. Applied literally to v1, that checklist is a large amount of
infrastructure standing between today and the first verdict.

**Adopt the boundary now. Defer most of the checklist.**

| Requirement | PrintScope v1 |
|---|---|
| Own database, own business logic | **Yes** — free, it's greenfield |
| `/api/v1/` versioned path | **Yes** — costs nothing on day one |
| Shop-scoped authorisation, never trust caller-supplied shop ID | **Yes** — §E3 `org_id` |
| Idempotency on writes | **Yes** — already planned via content hash |
| OpenAPI description | **Yes** — the generator already exists |
| Pagination / filtering / bounded responses | When the Hub adapter needs it |
| Scoped revocable per-shop credentials, OAuth | Phase 7, with the Printavo connection |
| Signed webhooks, retries, dedup, reconciliation | Phase 7+ — nothing consumes events yet |
| Contract tests, cross-shop authorisation tests | With tenant #2 |
| Rate limits, request IDs, health monitoring | With the hot-folder worker |

### F6. PrintScope may be the better first commercial candidate

The brief nominates Reorder Portal. But by its own account, Reorder Portal's
backend depends on Hub's synchronised order data, request storage and staff
inbox — all of which must be extracted or rebuilt before it can be sold, plus the
email/company-lookup privacy rework.

**PrintScope needs no extraction at all.** Built API-first from the first commit,
it *is* a commercial-ready product the day it works. It is also the lowest-risk
tenant-isolation story of the three: it stores facts JSON and verdicts long-term
and purges the artwork, so the sensitive asset — another shop's customer
artwork — barely persists.

That makes PrintScope the cheapest available experiment in whether anyone will
pay, and it is worth weighing against Reorder Portal before committing.

### F7. Net effect on this project: none

Everything above confirms §E rather than changing it. No functional change, no
change to the rule catalog, no change to the viewer. The ingestion contract
(§A), `org_id` in the schema (§E3), and conventions-as-config (§E1) were already
the plan; the brief independently arrives at the same boundary.

---

## Section G — Where PrintScope runs, and who talks to Printavo

Revises §A and §F. These are two separate questions that were being answered as
one.

### G1. Conceded: Mint's PrintScope should not talk to Printavo at all

The Hub already polls and syncs Printavo on a schedule, stores the result in
Postgres, and holds the credentials. A second poller against the same account
would:

- **spend the same rate-limit budget twice** — Printavo's limits are per account,
  not per application, so two pollers halve the headroom for both
- duplicate a scheduler, a cursor, a backoff strategy and a credential store that
  already exist and work
- create two sources of truth for the same invoice data

So **§A's "PrintScope owns its own Printavo connection" was wrong for Mint.**
The corrected design:

```
Printavo ──sync──► the Hub ──push job_context──► PrintScope
                                                     │
                                              verdicts, tallies
                                                     ▼
                                              Hub (API) · digest email
```

The Hub already knows when a new attachment lands — it is syncing anyway — so it
**pushes** rather than PrintScope polling. No second scheduler, no Printavo
credentials in PrintScope, no PrintScope credentials into the Hub's database.

### G2. The productisation path this enables — "dormant preparation"

This is the right shape, and it is what the Replit brief already proposed for
Reorder Portal: *"When connected to Hub, it could consume a supported Hub order
API. For shops without Hub, it could use its own Printavo connector. Both could
implement the same internal order-data interface."*

Apply that here. PrintScope defines **one internal interface** for job context,
with the implementation pluggable:

| `job_context.source` | Implementation | Status |
|---|---|---|
| `"hub"` | Hub pushes it | **built — Mint's path** |
| `"manual"` | intake form | **built — fallback** |
| `"printavo"` | direct per-tenant connector | **interface only, unbuilt** |

The direct connector is the dormant part: the seam exists, the code does not,
and it gets written when a shop without a Hub actually signs up. That is Tyler's
"dormant preparation in the backend", and it costs essentially nothing now.

### G3. Held: PrintScope still runs as its own service — because of the stack

Not for architectural tidiness. For two concrete reasons.

**1. It cannot be written in the Hub's language.** The Hub is React + Express +
Node. The entire validated Phase 0 pipeline is Python and Python-only:

- `pikepdf` for colorant enumeration, graphics-state tracking and content-stream
  rewriting — **there is no Node equivalent** for the plate-isolation work
- Ghostscript and `mutool` as CLI tools
- `scipy` for the raster fallback

Building "inside the Hub" would mean either rewriting and re-validating all of
it against a Node PDF library that can't do the same job, or running a Python
sidecar the Hub calls — which is a separate service with extra steps. It also
contradicts the standing decision that all new Breezy apps use Python/Flask.

**2. Blast radius.** PrintScope is the most CPU- and memory-hungry thing in the
stack: Ghostscript renders, vector extraction, an 8-plate file at 600 dpi. The
Hub's own open concerns already flag *"API and scheduler sharing one Express
process."* Adding heavy render work to that process risks degrading the
application the whole business runs on, to inspect a file. Keep failures in the
tool, not in the operating system.

### G4. What this changes about the productisation claim

§F6 said PrintScope needs *no* extraction to become a commercial product. Slight
correction: a non-Hub tenant needs the `"printavo"` adapter written.

That is **one adapter behind an existing interface**, not the extraction of a
backend, a data store and a staff inbox. Still far cheaper than Reorder Portal —
but it is not literally zero, and the doc shouldn't claim it is.

### G5. Open question — the Printavo integration scope

Worth pinning down before the Hub→PrintScope contract is designed:

1. **What is synced, and at what grain?** Invoices, line items, attachments,
   production dates — and are attachment *contents* fetched or only metadata?
2. **How often, and what are the actual limits?** Both Printavo's published rate
   limits and what the Hub's current sync consumes of them.
3. **Are attachments stored, or referenced?** If the Hub already has the output
   file bytes, PrintScope never touches Printavo even to fetch the artwork.
4. **Does the sync detect a *new* attachment on an existing invoice?** That is
   the trigger PrintScope needs, and it may not be something the current sync
   surfaces.

(4) is the one most likely to need work — syncing invoice records is not the same
as noticing a file appeared on one.

---

## Section H — Converged design, with corrections

The Replit agent's integration brief and §G arrive at the same architecture:
**one Printavo integration owned by the Hub, PrintScope as a separate Python
service.** What follows is what changed in the process.

### H1. Corrections accepted

Four places where the brief is right and this document was wrong or imprecise.

**"No PrintScope credentials in Hub" was sloppy.** Meant: no *database*
credentials. The Hub obviously needs an authenticated way to submit jobs. The
correct rule is:

> PrintScope never receives Printavo credentials. The Hub receives a narrowly
> scoped service credential for PrintScope's **API** — not its database, not
> administrative access. Human SSO stays a separate concern.

**Process separation alone is not failure isolation.** §G3 overstated the blast
radius argument. A separate process on the same machine still competes for the
same CPU. Separation only isolates when paired with CPU and memory limits,
concurrency caps, timeouts, and explicit handling of runaway jobs. Those belong
in v1, not later.

**"It cannot be written in Node" was too strong.** Node can invoke Python and CLI
tools, and `pdf.js` exposes operator lists. The honest and sufficient
justification is the brief's: *there is no demonstrated reason to rewrite an
already-validated Python implementation*, and the standing Breezy decision is
Python/Flask.

**A Hub-side cached summary is correct, not a second source of truth.** §F1b was
too pure. The Hub should retain inspection ID, source file version, processing
status, last-known verdict, last-refreshed time and a viewer link — otherwise
every Hub screen makes a live call. PrintScope owns the authoritative inspection;
the Hub holds an integration record.

Also accepted: two pollers "compete for the same allowance" rather than halve it;
and purging artwork does not by itself make PrintScope commercial-ready — uploads,
temporary renders, logs and extracted facts all still need protection.

### H2. The finding that reshapes v1: the attachment trigger gap

From the integration scope review:

> An attachment-only change may not reliably change the order fields used to
> trigger the supplemental refresh. There is a discovery mechanism, but not a
> guaranteed "new artwork ready" trigger, and no existing outbound file-ready
> integration.

**The Hub may not notice when seps.io attaches an output file.** That is the
trigger the whole automatic path depends on, and it does not currently exist.

Consequence — build in this order:

1. **Separate Python service**, manual upload plus an **"Inspect in PrintScope"**
   action on the invoice
2. Hub supplies the stored file and job context; processing runs asynchronously
3. Hub shows status, summary, viewer link
4. **Automatic inspection only after** attachment discovery, file-version
   detection and duplicate prevention are confirmed working

A targeted attachment refresh for jobs approaching production is likely the fix,
and it does not require a second Printavo poller.

### H3. Confirmed integration facts

| | |
|---|---|
| Rate limit | 10 requests / 5 seconds; GraphQL complexity limits also apply |
| Polling | every 5 minutes, plus daily refresh and background work |
| Headroom | **not measured** — do not assume spare capacity |
| Files | Hub mirrors production files, mockups and invoice PDFs into **private object storage** |
| Completeness | oversized/incomplete responses are tracked; PrintScope must receive freshness/completeness, not assume a snapshot is whole |

Two consequences:

- **PrintScope never touches Printavo, even for artwork.** The Hub already has
  the bytes. The trigger is *"an eligible artwork file has been successfully
  mirrored and a specific version is available."*
- **Production artwork ≠ mockups ≠ invoice PDFs.** These are not interchangeable
  analysis inputs, and the file registry holds all three. Wrong input type is a
  likely early bug.

### H4. PrintScope is not read-only — this changes what v1 persists

§F5 argued the transaction checklist down on the grounds that PrintScope is
"read-only analysis of files." That was incomplete. The *analysis* is read-only;
the *workflow* includes reports, emails and controlled Printavo writebacks.

So the brief is right that structured, versioned results must be persisted from
the first version — not a verdict and a PDF. Per assessed file:

job and file identifiers · file version and assessment version · print
location/imprint · individual plates · mesh per plate · ink colours and codes ·
underbase and special plates · confidence, warnings and human overrides ·
analysis date and rule-set version

These foundations are much harder to recover later than to design now, and most
of it is already in the §5 data model of the build plan — `facts` JSON,
`expected_snapshot`, `profile_version`. What's new is **print location**,
**human overrides**, and the provenance flag below.

### H5. Addition — mesh is *extracted* for Mint, *recommended* elsewhere

The brief says *"a mesh recommendation is not necessarily a fact embedded in the
file"* and asks that facts and recommendations be distinguishable. Correct — and
for Mint the answer is unusual:

**Mint's mesh is extracted, not recommended.** It is literally in the swatch
name: `5-230-Grey 428 C` → head 5, 230 mesh. No inference, no production rule.

For a shop without that naming convention, mesh would have to be *recommended*
from art detail, halftone content and ink colour — **a feature that does not
exist and would need building.** So the provenance flag matters more than it
first appears:

```
mesh: { value: 230, source: "extracted" | "recommended", rule_version: ... }
```

For Mint it is always `extracted`, which is why the screen forecast is reliable
on day one. This is another instance of §E1: Mint's convention is doing work that
looks like a product feature.

### H6. Addition — an artboard is not a setup

The brief's counting principle is the right one:

> Reuse analysis at the file level. Count production requirements at the
> job/imprint/setup level.

One Mint-specific rule to add, grounded in the sample files: **the underbase
lives on its own artboard** (22499, 22880). Two artboards, one imprint, one
setup. Counting artboards as setups would double every underbase job.

The validated rule stands: **plate count = unique colorants across all artboards,
minus `All`** — and that whole count belongs to a single setup unless the job
genuinely has a second imprint (front and back).

### H7. Addition — vector plates resolve the retention tension

The brief flags that the artwork purge point must be reconciled with what the
plate viewer needs to display later. There is a clean answer, and it already
exists.

**Keep the extracted vector plates; purge the source `.ai`.**

The viewer prototype renders per-separation SVG extracted from the original — 18
plates across four files totalling 1.84 MB. Those are not the customer's artwork
file. They are derived, per-plate, and they are exactly what the viewer needs.

So retention becomes: purge the uploaded `.ai` on schedule; keep facts JSON,
verdicts and vector plates indefinitely. The viewer keeps working on a
year-old inspection, and the customer's original file is gone. That also
materially improves the tenant-isolation story in §F6.

### H8. What nobody has mentioned in three rounds of architecture

The plumbing is now well specified. The rules are not.

The rule catalog has been validated against **four known-good files and zero
known-bad files.** That proves the parser reads correctly. It does not prove the
rules *catch* anything. Five image rules remain completely untested because no
sample contains a placed raster.

None of the architecture work changes the sequencing in the build plan:

- **Phase 0 still needs a rejected file.** Still the single most valuable missing
  asset in the project.
- **The shadow run (§6b of the build plan) is still the highest-value step** —
  run the extractor against the next ten real jobs and compare its verdicts to
  what the artist actually decided. Every disagreement is either a wrong rule or
  a tacit rule nobody wrote down.

Build the connection for the first workflow, as the brief recommends. But the
thing that decides whether PrintScope is trusted is not the integration — it is
whether the verdicts match the artist's judgment, and that is still unmeasured.

---

# Section I — Full automation: the eventual shape of this

*Tyler's stated intent, recorded here so the Replit build doesn't paint itself
into a corner. Not a v1 requirement. The point of writing it down now is that
several v1 decisions get cheaper if this is the known destination.*

## I1. The loop, as described

```
  Printavo invoice reaches <a specific status>
        │
        ▼
  app sees an OUTPUT file attached as a production file
        │
        ▼
  PrintScope runs the analysis
        │
        ├── PASS ──►  rename the file in place:  -22906 B  ->  #22906 B
        │             remove the production file from the invoice
        │             mark the Printavo invoice task complete
        │
        └── FAIL ──►  notify the art department with the report
                      file stays on the invoice, task stays open

  every run, either way, is written to a permanent log
```

That is a closed loop with no human in it on the happy path — which is exactly
what makes each piece below worth specifying carefully.

## I2. What this changes about v1 decisions

**The verdict has to be a value, not a page.** Everything in the loop branches on
pass/fail, so the engine's JSON result is the real product and the viewer is one
consumer of it. Already true of the architecture — keep it that way. Nothing
should compute a verdict inside the rendering layer.

**Yellow needs a policy.** Today yellow means "a person should look at this."
In an unattended loop there is no person, so every yellow needs a declared
destination: treat as pass, treat as fail, or route to a third "hold" state that
notifies without failing. This is a business decision, not a technical one, and
it should be a column in the rule table rather than a branch in code — the same
reason severity already lives there.

**Actions need to be idempotent and reversible.** Removing a production file from
an invoice and completing a task are both writes to the system of record. A retry
after a timeout must not double-complete, and a wrong verdict must be undoable.
Record the Printavo object ids and the prior state in the log so a bad run can be
walked back without guesswork.

**Dry-run mode is not optional.** The loop should be runnable in a mode where it
computes verdicts, writes the log and sends nothing — no Dropbox move, no invoice
edit, no task completion. That is how the false-negative rate gets measured
before anything is trusted to act unattended, and it is the same shadow-run
discipline §H8 argues for.

## I3. The log

Stated requirement: *a log should always be kept of all files processed, for
future reference if necessary.* Worth being concrete, because a log that only
records the verdict is useless the day someone disputes one.

Each entry should carry:

- invoice number, print location, filename, and the file's **content hash** —
  §8.5 of the findings doc has a real case where a file changed on disk between
  inspections, and a verdict that can't be tied to a specific byte-version can
  outlive the file it applied to
- the full rule result set, not just the verdict — including, separately, which
  rules did not apply, which could not be evaluated, which have no detector yet,
  and which errored. **An inspection reporting `complete: false` is never
  eligible for an automated pass**, whatever its verdict says
- the **rule table version** the verdict was computed against, so an old verdict
  can be understood in terms of the rules as they were, not as they are now
- what the app then did: file moved where, invoice edited, task completed, or
  who was notified
- timing, for the throughput question that will come up eventually

Retention should outlive the source file. §H7 already argues for keeping verdicts
and vector plates after the customer's original is gone; the log is the same
argument in stronger form.

## I4. Sequence — what has to be true before the loop closes

The order is not arbitrary. Each step is the thing that makes the next one safe.

1. **Verdicts match the artist.** §H8's shadow run. Until disagreement is near
   zero, automating the response to a verdict automates a coin flip.
2. **False-negative rate measured.** A false positive costs a look. A false
   negative sends a bad separation to the floor with nobody having opened it.
   These are not symmetric and should not share a threshold.
3. **Yellow policy decided.** See I2.
4. **Dry-run against live jobs.** Full loop, no writes, compared against what
   actually happened.
5. **Writes enabled, narrowest first.** The rename only — it changes a single
   character and is trivially reversible. Then task completion. Then removing
   the production file from the invoice, which is the only destructive step in
   the loop and should be last.

## I5. Risks specific to closing the loop

**Nobody opens the file any more.** Today a person looks at every output, even
briefly, and that glance catches things no rule encodes. Removing it means the
rule set is the only thing between a bad separation and a ruined run. The rule
table's known blind spots become production risk the day the loop closes:
gradients the parser can't attribute, the disabled choke-detail rule, every
image rule still untested for want of a sample.

**Status-triggered work fires on things you didn't mean.** A revision, a
re-upload, a manual status change, a test invoice — all look identical to the
trigger. Deduplicate on content hash plus invoice id, and make the log the
authority on whether something already ran.

**Marking a pass is a rename, not a copy.** Mint's decision: change the leading
`-` to `#` and leave the file where it is. No second copy, no storage growth, no
reconciliation between two versions of the same artwork. Two consequences worth
holding onto:

- Files from before this convention already start with `#`. The prefix means
  "passed inspection" only from the date the loop ships. Nothing downstream
  should infer inspection history from a filename.
- The rename is a marker; the log is the record. Because the log is keyed on the
  content hash, a file renamed by hand — or renamed and then revised — is still
  traceable to the verdict that was actually made.

**The destructive step is the one to be most careful with.** Removing the
production file from the invoice is the only action here that destroys state a
human might want back, and it should stay last in the sequence.

**Silence reads as success.** An unattended loop that stops firing looks exactly
like a quiet week. Whatever notifies the art department on failure should also
have a heartbeat, so nobody discovers in a month that the trigger broke.
