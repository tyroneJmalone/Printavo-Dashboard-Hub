# PrintScope — build brief

**For:** whoever is building this (Replit agent, contractor, or internal)
**From:** Mint Printworks
**Status of this document:** this is the work order. The other documents are
reference. If you read one thing before starting, read this, then `README.md`.

**Revision 2.** Four defects raised in review have been fixed in the engine
rather than left for the build — see §10. Two decisions have been made and are
now settled rather than open: this ships as a module inside the Hub, and a
passed file is marked by renaming rather than copying.

---

## 1. What you are building and why

Mint outsources colour separations to a vendor. Between the file arriving and it
going to the press floor, someone has to check it — and today that check needs
Illustrator and a trained eye, so it bottlenecks on two people.

PrintScope turns that judgement into verification. It opens a separation file,
runs a fixed set of rules against it, and renders a verdict per rule with a
picture next to it. **The goal is that someone with no design software and no
prepress training can do the check.**

It is not a file viewer with some warnings bolted on. It is a checklist that
happens to show you pictures.

### What success looks like

A person who has never used Illustrator opens the app, picks a file, and in
under a minute can tell you whether it goes to the floor or back to the vendor —
and can say *why*, in words a press operator would use.

---

## 2. What already exists — do not rebuild this

A working reference implementation is in `printscope-engine.tar.gz`. It is not a
prototype or pseudocode. It runs, and it has a test suite that proves it runs
correctly.

| Component | Status | Your job |
|---|---|---|
| `extract.py`, `raster.py`, `vector.py` | Working, measured against real files | **Port as-is. Do not rewrite.** |
| `detect.py` | 25 rule detectors, working | Extend, don't restructure |
| `printscope-rules-v2.csv` | 38 rules, thresholds calibrated | Load at runtime; never hardcode |
| `run.py` | Orchestrates one file → one result JSON | Wrap in a service |
| `build_site.py` | Static viewer, corrected through use | Port it, or rebuild to `UI-SPEC.md` |
| `test_engine.py` | 16 golden tests | Must stay green, always |
| `export_golden.py` | Baseline verdicts + fixture manifest | Compare your port against `golden/` |

### Why "do not rewrite" on the PDF code

Those three modules encode about a dozen findings that took substantial
measurement against real files to establish, and several of them look like bugs
until you understand what a separation file actually contains. The README lists
them under "Things that look like bugs and are not." Two examples so you know the
flavour:

- A choke is not geometry that was removed — it is a zero-ink stroke painted
  across the edge. A colorant filter cannot see it, so an isolated plate comes
  out 7.6% too large unless you mask it back out.
- The tool that renders plates emits invalid XML for these files, because every
  one of them has a layer called `Reg Marks & Info` and the bare `&` breaks
  strict XML parsing. The browser then renders nothing, silently, with no
  console error.

Re-deriving these costs days and the failures are invisible — the output looks
completely fine and is quietly wrong. That is the whole reason you are being
handed code instead of a specification.

---

## 3. Hard boundaries

Things that will be treated as defects if changed without a conversation:

1. **Don't change `MEASURE_DPI` from 200.** The trap thresholds in the rule table
   were calibrated at that resolution. Changing it moves every number.
2. **Don't reorder recolour and compose in `run.py`.** Recolour first, compose
   second. The reverse flattens the choke mask and is invisible except by
   measuring. There is a test for this.
3. **Don't enable `CHOKE_SAFE_FOR_DETAIL`.** It is disabled on purpose — it
   contradicts a file known to be correct. There is a test asserting it stays off.
4. **Don't collapse the four non-judgement statuses.** `not_applicable`,
   `cannot_evaluate`, `not_implemented` and `error` mean different things, and
   only the first is harmless. Never let automation act on any of them as
   though the check had passed, and never let a `complete: false` inspection
   through an automated gate whatever its verdict says.
5. **Don't move rule severity or thresholds into code.** They live in the CSV so
   that Mint can change them without a deploy. This is the core design decision
   of the whole project.
6. **Don't compute a verdict anywhere except the engine.** The UI renders a
   verdict; it never decides one.

---

## 4. Phases

Each phase ends with something demonstrable. Do not start a phase before the
previous one's acceptance criteria are met.

### Phase 0 — Prove the port (half a day)

Get the existing engine running unchanged in the target environment.

- `pip install -r requirements.txt`
- Install Ghostscript and MuPDF (`SYSTEM-DEPS.md`, `replit.nix` provided)
- Unpack the fixture corpus (delivered separately — 13 files, ~9MB)
- Verify the fixture hashes against `golden/MANIFEST.json`
- `python3 test_engine.py /path/to/corpus`

**Acceptance: 16 passed, 0 failed, 0 skipped.** The runner exits non-zero on
skips, so a partial run cannot read as success. Nothing else starts until this
is true. If a test fails, the environment or the port is wrong, and every later
phase will inherit the fault.

Then diff your output against `golden/` — baseline verdicts exported from the
environment these rules were calibrated in, each fixture pinned to its SHA-256.
Three of the thirteen come back `INCOMPLETE` by design; that is the correct
answer for those files, not a fault.

### Phase 1 — Inspection as a service

Wrap the engine so a file can be inspected over HTTP and the result persists.

- Upload endpoint: accepts a `.ai` file, returns a result id
- Result endpoint: returns the JSON described in `SCHEMA.md`, unchanged in shape
- Plate files (SVG/PNG) served as static assets
- Results stored durably — Postgres for the JSON, object storage for plates
- Store the `sha256_16` and index on it

**Acceptance:** inspect all 13 fixtures through the API and match `golden/`
exactly — verdict, per-rule status, and the `completeness` object. Same
verdicts, not similar.

### Phase 2 — The inspection UI

**The interface is specified, not open.** `UI-SPEC.md` is the design document:
layout, colour tokens for both themes, type scale, component anatomy, and the
full interaction spec. `build_site.py` is its reference implementation.

PrintScope is intended to stand alone rather than live inside the Hub, so there
is no house style to conform to — the spec *is* the house style.

Two acceptable routes:

- **Port the reference viewer.** It is a single static generator with no
  framework. Fastest, and guarantees fidelity.
- **Rebuild to the spec** in whatever stack suits, reading `UI-SPEC.md` and the
  reference implementation together.

Either way, §9 of the spec is mandatory reading before you touch the plate
viewer. Every item in it replaced a more obvious first attempt that the art team
rejected or that measurement proved wrong — stacking by default, two independent
opacity sliders, art-centred zoom, vector plates, ink colours read from the file.
Re-deriving them from first principles lands you back on the rejected version.

**Acceptance:** an art-team member compares it against the reference viewer on
the same file and finds nothing missing or changed.

### Phase 3 — Rule table admin

A screen where Mint can edit the rule table: severity, thresholds, remediation
text, enable/disable. Changes take effect on the next inspection with no deploy.

- Every change versioned, with who and when
- **Stamp the rule-table version onto every result**, so an old verdict can be
  read in terms of the rules as they were

This is small and it is what makes the system maintainable. Do not defer it.

**Acceptance:** flip a rule from fail to flag in the UI, re-inspect, and the
verdict changes accordingly — with no code change and no restart.

### Phase 4 — Printavo intake, read-only

Pull job context so rules that need it can run, and so files can be found
automatically. **No writes to Printavo in this phase.**

- Watch for OUTPUT files attached as production files once an invoice reaches an
  agreed status (see §6 — Mint must name the status)
- Inspect automatically, store the result against the invoice
- Surface it in the UI; notify nobody yet

**Acceptance:** two weeks of real jobs inspected automatically, with the results
compared against what the art team actually decided. Every disagreement is
either a wrong rule or a tacit rule nobody has written down — both worth finding
before anything is automated.

### Phase 5 — Closing the loop

Only after Phase 4's disagreement rate is near zero. Section I of
`printscope-roadmap-and-integrations.md` has the detail. Order the writes by how
hard they are to undo:

1. **Rename in place** — change the leading `-` to `#` on a passed file. Mint's
   decision: no second copy, no extra storage, and the prefix is marker enough
   for the art team. The log carries the content hash, so the audit trail does
   not depend on the filename surviving.
2. Mark the Printavo task complete
3. Remove the production file from the invoice — **last**

Plus: notify the art department on failure, and keep a permanent log of every
file processed. The log entry must carry the content hash, the full rule
results — with not-applicable, could-not-evaluate, not-implemented and errored
rules counted separately — the rule-table version, and what the app then did.

**An inspection reporting `complete: false` is never eligible for an automated
pass**, whatever its verdict says.

**Acceptance:** run the whole loop in dry-run mode — verdicts computed, log
written, nothing sent and nothing moved — against live jobs for a week, and the
dry-run log matches what a human would have done.

---

## 5. Out of scope for v1

State these back to us if you disagree, but don't build them without asking:

- Generating separation files (a separate, later project)
- Multi-tenant / other shops' Printavo accounts
- Editing or repairing files — PrintScope is read-only, always
- The five image rules — no sample file in the corpus contains a placed raster,
  so they cannot be tested yet
- Mobile-native anything; the responsive web view covers the iPad case

---

## 6. Decisions only Mint can make — these block Phase 4 and 5

Please chase these; they are not technical questions and they will stall the
build if they arrive late.

| # | Decision | Blocks |
|---|---|---|
| 1 | Which Printavo invoice status triggers inspection | Phase 4 |
| 2 | ~~Which Dropbox folder passed files move to~~ **Settled:** rename in place, `-` → `#` | — |
| 3 | The exact Printavo task name to mark complete | Phase 5 |
| 4 | **What a yellow means when nobody is watching** — pass, fail, or a third "hold" state that notifies without failing | Phase 5 |
| 5 | Who receives the failure notification, and by what channel | Phase 5 |
| 6 | How long results, plates and logs are retained | Phase 1 |
| 7 | Canonical print-location codes — the corpus contains `F`, `B`, `LC`, `RS`, `RS BN`, `F1`, `Left Leg`, and one customer's team name in the location slot | Phase 4 |

Number 4 is the important one. Today "yellow" means *a person should look at
this*. In an automated loop there is no person, so it needs a declared
destination — and it should land in the rule table as a column, not as a branch
in code.

---

## 6b. Two settled decisions

**This is a Hub module.** Not a separate user-facing app. It reuses staff access
and module permissions, stores results and rule history in the Hub database and
plates in private object storage, and runs inspections as queued background work
rather than inside an upload request. Keep the Python engine as a separate
processing component behind the Hub API — good isolation on its own merits, and
also what would let the engine be extracted later if PrintScope ever ships
outside the organisation. Only the UI would need rebuilding in that case.

`UI-SPEC.md` still governs the inspection screen. Fit it into the Hub's
navigation; keep the screen's behaviour as specified.

**A passed file is marked by renaming, not copying.** Change the leading `-` to
`#`. No duplicate, no extra storage, no reconciliation between two copies. Two
things to be aware of rather than to solve:

- Historical files from before this convention already begin with `#`. A `#`
  prefix means "passed inspection" only from the date this ships; it is not
  retroactive, and nothing should infer inspection history from a filename.
- The rename is a marker, not the record. The log is the record, keyed on the
  content hash — so a file renamed by hand, or renamed and then revised, stays
  traceable to the verdict actually made.

## 7. How we will judge this

In priority order:

1. **The golden tests stay green.** Every one encodes a conclusion checked by
   hand against a real file.
2. **False negatives matter more than false positives.** A false positive costs
   someone a look. A false negative sends a bad separation to the floor with
   nobody having opened it. Do not tune them against a single threshold.
3. **Verdicts are explainable.** Every fail and flag says what it measured and
   what to do about it, in words a press operator would use. The remediation
   text is in the rule table for exactly this reason.
4. **The rule table stays editable without a deploy.**

---

## 7b. What the first release must not claim

The first release is **assisted inspection**, not automatic approval. It answers
four questions and no more:

> What was checked? What passed? What needs attention? What could not be
> verified?

The fourth is load-bearing. An inspection where a rule could not run reports
`complete: false`, and the UI says so under the verdict. A yellow needs a
person; so does an incomplete pass. Neither is the tool clearing a file for
production.

## 8. Known weaknesses you are inheriting

Stated plainly so they are not discovered as surprises:

- The rules have been validated against known-good files. That proves the parser
  reads correctly and that the rules don't cry wolf. It does **not** prove they
  catch much — the honest score on deliberately planted defects has been mixed.
  The shadow run in Phase 4 is what settles this, and it is worth protecting
  from being crowded out by integration work.
- **12 of the 38 rules have no detector yet.** They report `not_implemented` and
  appear in the UI rather than being omitted, so the gap is visible rather than
  hidden. Closing it is scope to size, not to assume.
- The trap threshold has thin daylight. Correctly-untrapped files measure 76–93%
  bounded; one file the shop said needed a choke measures 80.6%. The yellow band
  exists because the metric cannot separate those two cases on its own.
- Gradients are partly invisible to the parser. Two rules suppress themselves
  when shading is present rather than guess.
- One rule is disabled pending recalibration.

None of these block the build. All of them are reasons the shadow run in Phase 4
is not optional.

---

## 9. First day checklist

```
[ ] Read this document, then README.md
[ ] Install Python deps, Ghostscript, MuPDF
[ ] Verify fixture hashes against golden/MANIFEST.json
[ ] python3 test_engine.py /path/to/corpus   →  16 passed, 0 failed, 0 skipped
[ ] python3 run.py "<one real file>"          →  a result JSON in queue/
[ ] python3 build_site.py                     →  open site/index.html
[ ] Read SCHEMA.md — this is the contract everything downstream depends on
[ ] Read UI-SPEC.md §9 before touching the plate viewer
[ ] Come back with: questions on §6, and anything in §3 you want to argue with
```

If the tests pass and the viewer opens, you have a working system on day one,
and everything after that is integration rather than discovery. That is the
point of handing over code.

---

## 10. Changes made in response to review

Four defects were raised against revision 1. All four are fixed in the engine,
so the build starts from corrected code rather than a corrected description.

**1. A failed or suppressed check could render as a clean pass.** The engine had
one `skip` status covering four different situations. It now distinguishes
`not_applicable`, `cannot_evaluate`, `not_implemented` and `error`, and every
result carries a `completeness` object with `complete: true/false`. A detector
that raises is reported as an error and forces `complete: false`; a rule with no
detector is reported rather than omitted. The UI shows a strip under the verdict
when an inspection is not complete. `SCHEMA.md` has the full model.

Three golden tests cover it: a deliberately broken detector must surface as an
error and must not report complete; unimplemented rules must appear in the
results; `not_applicable` must be provably distinct from `cannot_evaluate`.

**2. Thresholds were hardcoded while the documentation claimed they were
editable.** They now come from the rule row's `expected` and `tolerance` JSON
columns via a `Params` helper — trap bands, register tolerance, the
partly-based band, minimum stroke width, trim-residue count, trap sum. Values
are unchanged and every previous verdict reproduces. Two tests prove the wiring:
move a threshold in the CSV and the verdict must move with it.

`BASED_INK_PCT` deliberately stays in `config.py` — several rules consume it, so
it belongs to the measurement layer rather than to any one rule.

**3. Results were keyed by filename and could overwrite each other.** They are
now keyed `<filename>__<sha10>`, and each result carries an `inspection_id`,
`engine_version` and `rules_version`. A vendor resending revised artwork under
the original name no longer destroys the earlier verdict. A database should use
the same identity.

**4. The test suite could exit successfully with everything skipped.** It now
exits non-zero on any skip, with `--allow-skips` as a deliberate override. The
fixture corpus ships alongside this brief, and `export_golden.py` produces
baseline verdicts plus a manifest pinning each fixture to its SHA-256.

**One correction accepted without a code change:** a Dropbox move is not
additive, and revision 1 was wrong to call it that. Mint has since decided
against copying entirely — see §6b.
