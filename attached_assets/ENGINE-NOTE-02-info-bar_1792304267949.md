# Engine note 02 — info bar excluded from underbase coverage

**SepScope engine 0.4.1 → 0.4.2** · 18 October 2026 · validated on 57 files
**Patch:** `sepscope-infobar.patch` (5 files, applies with `patch -p1` or `git apply`)

---

## Short version

`UNDERBASE_COVERAGE` was counting the Pre-Press Pro info bar — the filename and
swatch label block in the margin strip above the artwork — as part of the
design. Those labels are painted in each ink and never sit on the underbase, so
they drag coverage down and raise a yellow flag on a file that is correct.

The fix locates the info bar by position and measures coverage below it.

**Validated across the full 57-file corpus.** Two verdicts change, both
`flag → pass` — the reported file and one more that was being flagged for the
same reason. No file gains a flag.

**Scope is deliberately narrow.** Only `UNDERBASE_COVERAGE` is touched. The
same contamination affects `TRAP_AT_NEGATIVE_SPACE` and is **explicitly not in
this change** — see §6.

---

## 1. The symptom, reproduced

Reported from the Hub: underbase coverage flags intermittently when the info
bar overlaps between artboards.

Reproduced exactly on `-22771 LC OUTPUT.ai`:

```
ink                     counted    actual    rule band
5-230-Brown 7518 C        83.9%     92.2%    15-85 = flag   <-- false flag
10-230-White              88.4%    100.0%    pass either way
6-230-Cream 7506 C        91.8%     96.9%    pass either way
```

Brown reads 83.9% with the strip counted, which lands inside the 15–85 "partly
based" band and raises the flag. The true figure is 92.2%.

That file's artwork begins 1.31in from the top of the board; the info bar
occupies 0.14in to 1.05in. There is 0.26in of empty space between them — the
two regions are not ambiguous, they were simply both being measured.

**Why it is intermittent:** it only bites when a colour's label line happens not
to overlap base. That depends on which line each ink lands on and how long the
text is, which varies per job.

## 2. Why layer and ink cannot be used

Two tempting filters are both wrong, and both were already ruled out during the
`ART_TEXT_OUTLINED` work:

- **By layer** — art legitimately sits on `Reg Marks & Info`. Measured earlier:
  8 of 16 files in one batch carry their artwork on the marks layer. A
  layer filter discards real artwork.
- **By ink** — the swatch labels are painted in each swatch's own ink by
  design. That is the whole point of the block.

**Position is the discriminator**, which is exactly what `ART_TEXT_OUTLINED`
already uses ("a text run whose origin falls inside the art bounding box is
artwork text wherever it lives"). This change applies the same principle to
pixel measurement.

## 3. What the fix does

New function `raster.info_bar_cut(cp, dpi)`. It builds a row profile of all
non-process ink, splits it into bands, and walks down from the top while each
band matches the label-text signature — thin (≤ 0.22in), light (≤ 2% of total
ink), and starting in the top 3in. It stops at the first band that does not
match and returns that row.

`raster.base_coverage()` calls it and measures each ink below the cut.

### Detected per file, not a fixed coordinate

The bar grows with ink count, so a constant would be wrong:

```
inks on the board     bar ends at
1                     0.59in
3                     0.82-0.90in
5                     1.06-1.09in
```

Measured across the full 57-file corpus: the bar was located on all 39 files
that have an underbase, and never once reached the artwork. Separation ranged
from **0.23in** (`#22617 B`) to 0.73in. The guard in the next section never
had to fire.

### It declines rather than guesses

`info_bar_cut` returns `None` — meaning "measure everything" — when no bar is
found, or when the bar ends within 0.10in of the first artwork band.

This matters more than the fix itself. Excluding the wrong rows would hide a
real defect in that region, and a missed defect reaching the press floor is
strictly worse than the yellow flag this change removes. An uncertain reading
must not quietly produce a clean number.

When the bar cannot be located, the rule says so in its detail rows:

> The info bar could not be located, so these figures include the filename and
> swatch labels, which never sit on the base. Treat a borderline reading with
> caution.

and when it can:

> Measured below the info bar — the filename and swatch labels are excluded.

`ctx["coverage_bar_cut_px"]` carries the row (or `None`) so the result records
what was excluded rather than leaving a reviewer to infer it.

## 4. Files changed

| File | Change |
|---|---|
| `raster.py` | New `info_bar_cut()`; `base_coverage()` applies it and now returns a third value, the excluded row |
| `run.py` | Unpacks the third return value into `ctx["coverage_bar_cut_px"]` |
| `detect.py` | `UNDERBASE_COVERAGE` states whether the strip was excluded |
| `test_engine.py` | New test "info bar excluded from coverage" |
| `config.py` | `ENGINE_VERSION` → 0.4.2 |

**One signature change to watch:** `base_coverage()` returns three values now,
not two. `run.py` line ~231 is the only caller in the engine. If the Hub calls
it anywhere else, that call site needs updating too — this will fail loudly as
a tuple-unpacking error rather than silently, but check for it.

Nothing else moves: no thresholds, no rule-table values, no PDF extraction, no
plate geometry, no trap logic.

## 5. Verification

Done here, please repeat:

```
18 passed, 0 failed, 0 skipped
```

Golden baseline, 13 fixtures, status-by-status comparison:

```
22771_LC            VERDICT flag -> pass;  UNDERBASE_COVERAGE: flag -> pass
all 12 others       no verdict or status change (detail text only)
```

Full 57-file corpus, `UNDERBASE_COVERAGE` before and after:

```
-22771 LC   5-230-Brown 7518 C    83.9%  ->   92.2%    FLAG -> pass
#22541 LC   5-230-Pink 1777       74.4%  ->  100.0%    FLAG -> pass
```

Both are the reported defect: the label block was the only thing holding those
inks below the 85% line. `#22541 LC` had not been reported and was being
flagged for the same reason.

39 of the 57 files carry an underbase; the rest are correctly `not_applicable`.
No other verdict moved, no file gained a flag, and no file errored. That is the
whole behavioural effect of this change.

The new test takes a fixture with an info bar, asserts the bar is located,
asserts the cut lands inside the observed 0.4–1.25in band, asserts
`base_coverage` reports the row it excluded, and asserts the Brown ink on
`-22771 LC` now reads above 85%. It fails if the strip is counted again.

**Please also confirm by eye on `-22771 LC` in the Hub** that the rule now
passes and that its detail rows carry the "Measured below the info bar" line.

## 6. Explicitly not in this change

`TRAP_AT_NEGATIVE_SPACE` reads perimeter adjacency off the same plates and is
contaminated the same way. Measured with the fix applied, one fixture would
cross a band: `#22560 B` White, 84.1% → 85.6%, `flag → pass` — clearing the 85
threshold by 0.6 points.

Mint's decision is to address the reported issue only and leave the trap rule
alone for now. **Do not extend `info_bar_cut` to that rule as a tidy-up.** It is
a separate change with its own verdict movement and should be reviewed on its
own terms.

## 7. Known limits

- **The corpus tops out at five inks on a single board.** A higher-ink job has
  a taller bar, and the narrowest separation measured is 0.23in. Pre-Press Pro
  switches the label block to two columns above four entries, which limits the
  growth — but that is read from the script, not measured. The 0.10in guard in
  §3 protects this case; if it starts returning `None` on real jobs, that is the
  signal working, not a bug.
- Black inks read very low coverage by design and still flag on `#22560 B` and
  `#22617 B`. That is pre-existing behaviour, unrelated to this change, and is
  the `UNDERBASE_REQUIRED_DARK` gap rather than a coverage defect.
