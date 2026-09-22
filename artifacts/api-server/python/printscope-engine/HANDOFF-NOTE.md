# PrintScope — reply to your review, and what happens next

**To:** the team building this
**Re:** your assessment of the revision-1 handoff
**Bundle:** `printscope-engine.tar.gz` (rev 2) + `printscope-fixtures.tar.gz`

---

## Short version

Your four findings were all correct. All four are **fixed in the engine**, not
deferred to the build — so you start from corrected code rather than a corrected
description. The review was good and it caught things that mattered; thank you
for reading the code rather than only the prose.

Two open questions are now settled by Mint: **this ships as a Hub module**, and
**a passed file is marked by renaming, not copying**.

Everything you asked for is attached, including the fixture corpus and the
golden verdicts.

---

## Your findings, and what changed

### 1. "Clear to run" could coexist with incomplete evaluation

You were right, and this was the most serious of the four. The engine had a
single `skip` status covering four genuinely different situations, and
`overall()` only looked for fail and flag — so a file where two detectors
crashed and eight rules never ran would render as a clean pass.

**Fixed.** There are now four distinct non-judgement statuses:

| Status | Means | Forces `complete: false`? |
|---|---|---|
| `not_applicable` | Genuinely nothing to check — no underbase, no white ink | No |
| `cannot_evaluate` | The rule applies and could not run — gradients the parser cannot attribute, a measurement that failed | **Yes** |
| `not_implemented` | In the rule table, no detector yet. Reported rather than omitted | No, but always shown |
| `error` | The detector raised | **Yes** |

Every result now carries a `completeness` object:

```json
{"complete": false, "judged": 23, "not_applicable": 0,
 "cannot_evaluate": 2, "not_implemented": 12, "errors": 0,
 "unverified": ["ARTWORK_IN_REGISTER: gradient blend present — plates deliberately do not align"]}
```

`verdict` answers *what did the rules find*. `completeness` answers *did enough
of them run to trust that*. Deliberately separate fields.

You can see the difference on fixture `#22617 B`. It used to read "Look at it"
with no indication that registration had never been verified. It now reports
`complete: false` and names the two checks that did not run. Three of the
thirteen fixtures come back INCOMPLETE — that is the correct answer for them,
not a fault.

We agree with your instinct not to make every skip a failure. `not_applicable`
genuinely does not apply and does not count against completeness.

Three golden tests cover this: a deliberately broken detector must surface as
`error` and must not report complete; unimplemented rules must appear in the
results; and `not_applicable` must be provably distinct from `cannot_evaluate`
on two real files.

### 2. Thresholds were hardcoded while the docs claimed they were editable

Correct, and the documentation was the defect. Severity, remediation and the
enabled flag did come from the CSV. The numbers did not.

**Fixed.** Thresholds now reach detectors through a `Params` helper that merges
the row's `expected` and `tolerance` JSON columns:

- `TRAP_AT_NEGATIVE_SPACE` — the 70% / 85% bands
- `ARTWORK_IN_REGISTER` — the 0.02pt tolerance
- `UNDERBASE_COVERAGE` — the 15% / 85% partly-based band
- `STROKE_MIN_WIDTH`, `TRIM_ARTIFACT_RESIDUE` — 0.25pt, count of 3
- `UNDERBASE_CHOKE_PER_OBJECT` — the 0.75pt sum and its tolerance

Values are unchanged and every previous verdict reproduces. A detector reads
`p.num("trap_required_below_pct", 70)` — the table owns the number, the code
carries only a fallback so a malformed cell does not take a check offline.

Two tests prove the wiring by moving a threshold in the CSV and requiring the
verdict to move with it. That is the guarantee your rule-admin screen depends
on, and it is now asserted rather than claimed.

**One number deliberately stays in code:** `BASED_INK_PCT` in `config.py` — the
share of a colour that must sit on the base before it counts as based. Several
rules consume it, so it belongs to the measurement layer, not to any one row.
Flagging it so it does not look like an oversight.

### 3. Results were keyed by filename

Correct, and an inconsistency in our own work — the findings document records a
case where a file changed on disk between two inspections, argues verdicts must
pin to content, then the runner keyed results on the filename anyway.

**Fixed.** Results are keyed `<filename>__<sha10>`, and each record carries
`inspection_id` (uuid), `engine_version` and `rules_version` (a fingerprint of
the rule table as it was). A vendor resending revised artwork under the original
name no longer destroys the earlier verdict. Use the same identity in the
database.

### 4. The test runner could exit successfully with everything skipped

Correct. **Fixed** — it exits non-zero on any skip, with `--allow-skips` as a
deliberate override.

The fixture corpus is attached, and `export_golden.py` produces baseline
verdicts plus `golden/MANIFEST.json`, which pins every fixture to its SHA-256 so
you can prove you are comparing against the same bytes.

### And the one we accepted without a code change

**A Dropbox move is not additive.** You were right; the brief was wrong to call
it that. See the next section — Mint has decided against copying entirely.

---

## Two decisions now settled

### This is a Hub module

Agreed, and for your reasons. Reuse staff access and module permissions, store
results and rule history in the Hub database with plates in private object
storage, run inspections as queued background work rather than inside an upload
request, and keep inspection processing isolated from Purchasing and AutoPrint.

Keep the Python engine as a separate processing component behind the Hub API, as
you proposed. That is good isolation on its own merits and it also keeps the
door open: if PrintScope ever ships outside the organisation, the engine
extracts and only the UI needs rebuilding.

**One adjustment to what you proposed.** The inspection screen is specified, not
open — `UI-SPEC.md` is in the bundle. It went through several rounds of
correction with Mint's art team, and §9 lists eight behaviours that each
replaced a more obvious first attempt: artboards stacked by default rather than
exclusive tabs, two independent opacity sliders rather than one, zoom centred on
the artwork rather than the 16-inch artboard, vector plates rather than raster,
ink colours read from the file rather than guessed from the swatch name. Fit it
into the Hub's navigation and shared styling; keep the screen's behaviour.
`build_site.py` is the reference implementation and is a single static
generator with no framework, so porting it is also a legitimate option.

### A passed file is renamed, not copied

Mint's call: change the leading `-` to `#` and leave the file where it is. No
duplicate, no storage growth, no reconciliation between two copies. The prefix
is marker enough for the art team.

Two things to be aware of rather than to solve:

- Historical files from before this convention already begin with `#`. The
  prefix means "passed inspection" only from the day this ships. Nothing
  downstream should infer inspection history from a filename.
- The rename is a marker; **the log is the record**, and it is keyed on the
  content hash. A file renamed by hand, or renamed and then revised, stays
  traceable to the verdict actually made.

Your point about the Hub's Dropbox integration being deliberately read-only
still stands for the later phases, and the rename does not change that — it is
still a write, and still belongs behind the same deliberate decision.

---

## Where we would push back, gently

### The shadow run is missing from your "before building" list

Your list — corpus, docs, golden JSON — is right and now satisfied. But the
thing that decides whether anyone trusts this tool is not on it.

The rules are validated against known-good files. That proves the parser reads
correctly and that the rules do not cry wolf. It does **not** prove they catch
much; the honest score against deliberately planted defects has been mixed. The
Phase 4 shadow run — inspect real jobs automatically, compare verdicts against
what the art team actually decided, change nothing — is still the highest-value
unbuilt thing in the project. Every disagreement it surfaces is either a wrong
rule or a tacit rule nobody has written down.

It is easy for that to get crowded out by integration work that feels more
concrete. Please protect it.

### 12 of 38 rules have no detector — treat that as scope, not background

Enabled rules: 37. With detectors: 25. Without: 12, namely

```
FILL_STROKE_SAME_COLORANT   IMAGE_HARD_MIN_DPI      IMAGE_MIN_DPI
IMAGE_NOT_RGB               INK_CHANGE_DECLARED     INK_OVERLAP_NOT_TRAP
PLATE_COUNT_MATCHES_ORDER   PRINT_SIZE_VS_LOCATION  SWATCH_LABEL_MANIFEST
UNDERBASE_ABSENT_LIGHT      UNDERBASE_REQUIRED_DARK UNDERBASE_ROLE_AGREES
```

They now report `not_implemented` and appear in the UI, so the gap is visible
rather than hidden. Three of them depend on job context from Printavo
(`PLATE_COUNT_MATCHES_ORDER`, `UNDERBASE_REQUIRED_DARK`, `UNDERBASE_ABSENT_LIGHT`
need the ordered colour count and the garment colour) and unblock naturally in
Phase 4. The image rules cannot be tested at all — no file in the corpus
contains a placed raster. Size this rather than assume it.

---

## Next steps, in order

### Step 1 — Prove the port (half a day)

```
pip install -r requirements.txt
apt-get install -y ghostscript mupdf-tools     # or the provided replit.nix
tar xzf printscope-fixtures.tar.gz
python3 test_engine.py /path/to/printscope-fixtures
```

**Acceptance: 16 passed, 0 failed, 0 skipped.** Then verify the fixture hashes
against `golden/MANIFEST.json` and diff your run against the `golden/*.json`
baselines — verdict, per-rule status, and the `completeness` object.

Nothing else starts until this is green. If it is not, the environment or the
port is wrong and every later phase inherits the fault.

### Step 2 — Inspection as a service

Wrap the engine. Upload endpoint returns an id; result endpoint returns the JSON
in `SCHEMA.md` unchanged in shape; plates served as static assets; results in
Postgres, plates in object storage; index on `sha256_16`.

Queue the work — do not inspect inside the request. `#21797` in the wider corpus
is 28,860 objects and takes minutes.

**Acceptance:** all 13 fixtures through the API match `golden/` exactly.

### Step 3 — The inspection UI

Per `UI-SPEC.md`, fitted into Hub navigation. Read §9 first.

**Acceptance:** an art-team member compares it against the reference viewer on
the same file and finds nothing missing or changed.

### Step 4 — Rule table admin

Edit severity, thresholds, remediation and the enabled flag; changes take effect
on the next inspection with no deploy. Version every change with who and when,
and stamp the rule-table version onto every result.

This is small, and it is what makes the system maintainable after handover.
Please do not defer it.

**Acceptance:** flip a rule from fail to flag in the UI, re-inspect, and the
verdict changes — no code change, no restart. Thresholds now genuinely back
this; two tests guarantee it.

### Step 5 — Printavo intake, read-only

Watch for OUTPUT files attached as production files once an invoice reaches the
agreed status. Inspect automatically, store the result against the invoice,
surface it in the UI. **Notify nobody. Write nothing back.**

Run it for two weeks against real jobs and compare every verdict to what the art
team actually decided. This is the shadow run. It is the acceptance criterion
for everything after it.

### Step 6 — Close the loop

Only once the disagreement rate is near zero. Section I of the roadmap has the
detail. Order the writes by how hard they are to undo: rename first, then the
Printavo task, then removing the production file from the invoice — last,
because it is the only step that destroys state a human might want back.

**Hard gate: an inspection reporting `complete: false` is never eligible for an
automated pass, whatever its verdict says.**

---

## What we still owe you

These are business decisions, not technical ones, and late answers will stall
Steps 5 and 6.

| # | Decision | Blocks |
|---|---|---|
| 1 | Which Printavo invoice status triggers inspection | Step 5 |
| 2 | The exact Printavo task name to mark complete | Step 6 |
| 3 | **What a yellow means when nobody is watching** — pass, fail, or a third "hold" state that notifies without failing | Step 6 |
| 4 | Who receives the failure notification, and by what channel | Step 6 |
| 5 | How long results, plates and logs are retained | Step 2 |
| 6 | Canonical print-location codes — the corpus contains `F`, `B`, `LC`, `RS`, `RS BN`, `F1`, `Left Leg`, and one customer's team name in the location slot | Step 5 |

Number 3 is the important one, and when it is answered it should land in the
rule table as a column rather than as a branch in code — same reasoning as
severity.

---

## What we would like back from you

1. **The Step 1 result**, including any fixture whose golden verdict you cannot
   reproduce. A mismatch there is worth stopping for.
2. **Anything in the hard-boundaries list (§3 of the build brief) you want to
   argue with.** It is a list of things that will look like tidy-ups and are
   not; if one of them is genuinely wrong we would rather hear it now.
3. **Your sizing on the 12 unimplemented rules**, split between the three that
   unblock with Printavo context and the rest.

---

## One last thing

The first release is **assisted inspection**, not automatic approval. It answers
four questions:

> What was checked? What passed? What needs attention? What could not be
> verified?

The fourth is new in rev 2 and it is load-bearing. A yellow needs a person. So
does an incomplete pass. Neither is the tool clearing a file for production, and
the copy should never imply otherwise.
