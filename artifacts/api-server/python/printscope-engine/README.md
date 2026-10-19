# PrintScope engine — reference implementation

**Start with `HANDOFF-NOTE.md`.** It is the current reply to the building
team: what changed in response to their Phase 0 review, the two decisions
Mint has settled, where we push back, and the next steps in order. Read it
before `BUILD-BRIEF.md`, which it amends.

**This code is the specification.** Two prose documents travel with it and
explain *why* it works this way and what is still unknown:

- `printscope-phase0-findings.md` — the evidence. Every rule threshold traces
  back to a measurement in here, including the ones that were wrong first.
- `printscope-roadmap-and-integrations.md` — deferred features, the Printavo
  and Hub integration reasoning, and Section I, the eventual automation loop.

They are background. Where a document and this code disagree, the code is
right, because the code is what was measured against real files.

An earlier `sep-inspector-build-plan.md` exists and is **superseded** — its
data model predates the schema in `SCHEMA.md`. Do not build from it.

Do not re-derive the PDF handling from the prose. Several parts of it are
counter-intuitive, took a lot of measuring to get right, and look like bugs
until you understand what a separation file actually contains. The specific
traps are documented at the bottom of this file.

```
config.py      paths and tunables, all env-overridable. Nothing else hardcodes a path
extract.py     PDF -> facts. Knows nothing about rules, severity or presentation
raster.py      Ghostscript tiffsep plates + the measurements that need pixels
vector.py      per-separation plate extraction to SVG, and the knockout mask
detect.py      one function per rule code. Returns a status; the CSV sets severity
run.py         file -> facts -> context -> verdicts -> plate files -> queue/<slug>.json
build_site.py  queue/*.json -> a static viewer
test_engine.py 19 regression tests, including conservative info-bar exclusion
export_golden.py  writes golden/ - baseline verdicts plus a fixture manifest
```

## Running it

```bash
pip install -r requirements.txt          # see SYSTEM-DEPS.md for gs and mutool
python3 run.py "/path/to/#22499 F OUTPUT.ai" [more files...]
python3 build_site.py
python3 test_engine.py /path/to/corpus   # expect 19 passed, 0 failed, 0 skipped
```

`run.py` appends to `queue/`; nothing is lost between runs. `queue/archive/` is
ignored by the viewer — park results there to keep them for re-running rules
without showing them.

**Run the tests first.** If they pass, the environment is sound and the port is
faithful. If they fail, fix that before anything else — each one encodes a
conclusion that cost real effort to establish.

The suite **exits non-zero on skips**. A skipped test did not run, and treating
that as success produces exactly the false reassurance the suite exists to
prevent. `--allow-skips` overrides it if you knowingly want a partial run.

`export_golden.py` writes the baseline verdicts and a manifest pinning each
fixture to its SHA-256, so a port can prove it is comparing against the same
bytes.

## The seam that matters

`extract.py` → `detect.py` is the line between PDF mechanics and shop
convention. Above it, nothing knows what a choke is. Below it, nothing parses a
PDF. Mint's conventions change; the PDF spec does not. Keep the line.

## The rule table is the product

`printscope-rules-v2.csv` is read at run time. Severity, remediation text, the
enabled flag **and the thresholds** all live there. Changing a rule from red to
yellow, or moving the trap band, is a spreadsheet edit — which is also what lets
the same table drive a future Illustrator generator through its
`illustrator_action` column.

Thresholds reach a detector through `Params`, which merges the row's `expected`
and `tolerance` JSON columns. A detector reads `p.num("trap_required_below_pct",
70)` — the table owns the number and the code carries only a fallback for a
malformed cell. Two golden tests prove this: move a threshold in the table and
the verdict must move with it, or the test fails.

One number is deliberately **not** a rule threshold: `BASED_INK_PCT` in
`config.py`, the share of a colour that must sit on the base before it counts as
based. Several rules consume it, so it belongs to the measurement layer rather
than to any one row.

A rule with no detector is reported as `not_implemented` rather than omitted, so
the table can carry rules ahead of their implementation without a verdict
quietly covering for them. 38 rules exist, 1 is disabled, 25 have detectors.

`severity` (what the table says the rule is worth) and `status` (what happened
on this file) are different fields, and there are four distinct non-judgement
statuses. `SCHEMA.md` explains why that matters.

## Output contract

`SCHEMA.md`. The result JSON is the real deliverable — the viewer is one
consumer of it. Rewrite the UI in whatever stack suits; keep the schema.

---

# Things that look like bugs and are not

Each of these was found the hard way. All are covered by `test_engine.py`.

### A choke is not geometry

It is a zero-ink stroke painted across the shape edge with overprint off: it
writes 0% to the spot plate and eats into it. It is painted in DeviceCMYK, not
in the separation, so a colorant filter cannot see it and an isolated underbase
comes back at full un-choked size — 7.6% too large on one measured file.

`knockout_svg()` isolates those strokes and `compose_knockout()` masks the plate
with them. Against the Ghostscript separation as ground truth:

```
base, un-masked    19,534 px     27% too large
base, masked       15,383 px     0.05% off
tiffsep reference  15,390 px
```

**Order matters.** `compose_knockout` builds a luminance mask from a white rect
and black strokes. `recolour` rewrites every fill and stroke to the ink colour —
so running it *after* composing turns the mask rect and the knockout strokes the
same colour, flattening the mask and silently removing the choke. Recolour
first, compose second. This shipped wrong once and was invisible except by
measuring: the plates looked perfectly fine, they were just un-choked.

### mutool changes how it spells SVG dimensions between versions

1.23 writes `width="1152pt"`; 1.25 writes `width="1152"`. Same number, same
viewBox, different spelling — and any parser that insists on one of them stops
finding the plate's dimensions.

Two places depended on the spelling and both failed *silently*: `compose_knockout`
returned the plate unmasked (an un-choked plate, which looks perfectly correct),
and `SVGSIZE` in `run.py` recorded `w=h=0`, which switched off the art bounding
box and with it the zoom-to-artwork behaviour.

Both now accept any CSS unit or none. Two further rules follow from this and are
load-bearing:

- **Never re-emit a unit you did not read.** `1152` and `1152pt` are not the same
  size — 1pt = 1.333px. `compose_knockout` therefore reuses the plate's own
  `<svg>` open tag verbatim and parses only the viewBox, which is all the mask
  actually needs.
- **Never silently return an unmasked plate.** `compose_knockout` raises
  `ChokeCompositionError`; `run.py` records it in `previews[].choke_failed` and
  the viewer says the plates are drawn un-choked. Covered by the golden test
  "svg dimensions parse in both renderer formats", which composes in both
  formats and asserts the mask geometry comes out byte-identical.

### mutool emits bare ampersands

It copies Illustrator layer names into `data-name` attributes, and every one of
these files has a layer called `Reg Marks & Info`. That makes the document
invalid XML, and an SVG loaded through `<img>` is parsed strictly — so the
browser renders nothing at all, with no error in the console. `sanitise()`
escapes them; `is_well_formed()` refuses to ship a plate that still will not
parse.

### tiffsep gives composited plates, not authored ones

Ghostscript's separation output has each ink knocked out wherever another colour
overprints it. The vector isolation shows the authored geometry — what actually
gets burned. They agree to IoU 0.999 on flat art and diverge in overlap regions.
Use the raster for measurement, the vector for display, and don't expect them to
match pixel for pixel where inks overlap.

### Ink colour comes from the file

mutool renders a separation in its real alternate colour, so Grey 428 C arrives
as `#c1c5c8` and the underbase as Rhodamine `#e50695`. The name-based palette in
`run.py` is only a fallback for raster plates. Guessing from the swatch name
renders a green plate red, which is worse than useless to someone checking a
separation.

### `sh` shading carries no colorant

An ink used only inside a gradient looks unused to the parser.
`NO_EMPTY_PLATES` and `ARTWORK_IN_REGISTER` both suppress themselves when
shading is present rather than accuse a file the parser cannot fully see. This
is a known gap, not a workaround to remove.

### Graphics state does not inherit into Form XObjects the way you expect

An early version reset line width and stroke colourspace when recursing into a
form and lost every stroke's colour. Pass them through.

### Illustrator sets colour with implicit operators

Stroke colour arrives as `K`, not `CS`/`SCN`. A parser watching only the
explicit operators finds nothing at all.

---

# Known gaps, stated plainly

- **`CHOKE_SAFE_FOR_DETAIL` is disabled.** The erosion metric matched the
  vendor's technique choice 3/3 in Phase 0, but the rebuilt detector contradicts
  a file known to be correctly choked. It is sensitive to render dpi, kernel
  shape and whether it runs on authored or composited geometry. Not shipping
  until those are pinned down. `test_engine.py` asserts it stays off.
- **A shifted colour on a single-artboard file with no underbase is not
  detectable** from the file alone — there is no reference to measure against.
- **Image rules are untested.** No placed raster exists in any file in the
  corpus, so five rules have never been exercised.
- **The trap threshold has thin daylight.** Untrapped-but-correct files measure
  76–93% bounded; one file the shop said needed a choke measures 80.6%. The
  70–85% yellow band exists precisely because the metric cannot separate those
  two cases on its own.
- **Rules are validated against known-good files.** That proves the parser reads
  correctly and that the rules don't cry wolf. It does not prove they *catch*
  much. The shadow run described in the build plan is still the highest-value
  outstanding step.
