# Engine note 02b — reply to review, hardened detector

**SepScope engine 0.4.1 → 0.4.3** · 18 October 2026
**Patch:** `sepscope-infobar-v2.patch` — supersedes the first patch, which should be discarded.

---

## Short version

All three concerns are valid. Two were defects in what I sent; the third was a
real question that needed measuring rather than answering.

The counterexample is reproduced, fixed, and now covered by a test. The
detector gained a condition it should have had from the start.

**Do not install the archive I sent.** You were right about that, and it was my
error to include it — see §1.

---

## 1. The archive — withdrawn

You are correct and the mistake was mine. The archive was a rebuild of the
0.4.1 bundle and carries none of your eight October checks or your strengthened
renderer tests. Installing it would have reverted real work.

I have deleted it. **Apply the patch only.** It touches six files and nothing
else, so your additions are untouched.

One of those six is `test_engine.py`. If your strengthened versions of those
tests live in the same file, take the patch's two new test functions and their
`TESTS` entries by hand rather than applying that hunk wholesale — your versions
win on any overlap.

## 2. The counterexample — reproduced, and the detector was wrong

Your synthetic case is exactly right. Reproduced here:

```
small element 0.30-0.50in, main design 1.50-4.50in, no info bar
old info_bar_cut -> row 99      <-- excluded real artwork
```

And your reading of the 6,000px floor was correct too. On a design totalling
66,400px the floor permits a band of 9.0% of all ink while the comment claims
2%. The floor overrode the ratio precisely on the small designs where the ratio
mattered most.

**The missing condition is live text.** Pre-Press Pro writes the filename and
swatch labels as *live* text. Artwork text is outlined — that is what
`ART_TEXT_OUTLINED` exists to enforce — so artwork contains no text origins at
all. A band that holds no text origin cannot be a label line.

Measured across the corpus: **every band of every real info bar contains a live
text origin**, on every artboard. It is a reliable necessary condition.

So the detector now requires, for each band, all of:

1. thin (≤ 0.22in) and inside the top 3in — the shape and place of a label line
2. **contains a live-text origin** — the new condition, and the one that does
   the real work
3. the bar as a whole must end ≥ 0.10in clear of the first artwork band

The ink-share test is **gone**. It was a weak proxy for "this is text", and with
a direct test available it was both redundant and harmful — a pure 2% share
declined on `-22771 LC`, the very file this fix exists to repair, because on a
small LC board the label block is legitimately a larger fraction of total ink.
Your instinct that the threshold was wrong was right; the answer turned out to
be removing it rather than retuning it.

`info_bar_cut` now takes `text_rows` and **returns `None` when they are not
supplied**, so a caller that does not pass them gets the pre-fix behaviour
rather than a guess.

### Residual risk, stated plainly

A thin band of real artwork, in the top 3in, that happens to contain a *live*
text origin would still be excluded. That requires live text sitting on the
artwork — which `ART_TEXT_OUTLINED` already fails the file for. I am not
claiming it is impossible, only that it is a condition the engine already
reports as a defect.

## 3. Downstream effects — measured, not assumed

You were right to ask rather than take my word for it. `based_inks` does change:

```
-22771 LC    gains  5-230-Brown 7518 C      loses nothing
#22541 LC    gains  5-230-Pink 1777         loses nothing
```

Both files *gain* an ink. Nothing drops out of the list anywhere in the corpus,
which is the direction that matters — a rule that consumes `based_inks` sees
more inks as based, not fewer.

I then ran **all 37 rules** before and after on both files:

```
-22771 LC    1 status change across 37 rules:  UNDERBASE_COVERAGE  flag -> pass
#22541 LC    1 status change across 37 rules:  UNDERBASE_COVERAGE  flag -> pass
```

Register and choke-detail do not move on either file. That is the measurement
you asked for, and it says the downstream effect is nil on this corpus.

## 4. Full-corpus validation, hardened detector

57 files, 39 of which carry an underbase:

```
bar located          39 of 39
guard declined        0
narrowest separation  0.23in  (#22617 B)      widest 0.73in
errors                0
```

Coverage verdict changes — the whole behavioural effect:

```
-22771 LC   5-230-Brown 7518 C    83.9%  ->   92.2%    flag -> pass
#22541 LC   5-230-Pink 1777       74.4%  ->  100.0%    flag -> pass
```

`#22541 LC` was not reported by the shop and was being flagged for the same
reason. No file gained a flag.

```
19 passed, 0 failed, 0 skipped
```

## 5. Tests added, per your list

**"info bar detector is conservative"** — synthetic, no fixture needed, covers
four of the cases you asked for:

| Layout | Expected |
|---|---|
| Small artwork above larger, no label block | declines |
| Same, with live text elsewhere on the board | declines |
| No text positions supplied at all | declines |
| Label block crowding the artwork (< 0.10in) | declines |
| Genuine two-line bar, clear of the art | cuts at the second line |

**"info bar excluded from coverage"** — the real-file case, asserting the bar is
located, the cut lands inside the observed band, the excluded row is reported,
and the Brown ink on `-22771 LC` reads above 85%.

## 6. Files in the patch

| File | Change |
|---|---|
| `raster.py` | `info_bar_cut()` now text-gated and share-free; new `text_rows_for()`; `base_coverage()` takes `text_rows`, returns the excluded row |
| `run.py` | Passes `text_rows_for(colour artboard)`; records `ctx["coverage_bar_cut_px"]` |
| `detect.py` | `UNDERBASE_COVERAGE` states whether the strip was excluded |
| `test_engine.py` | Two new tests (see §5) |
| `config.py` | `ENGINE_VERSION` → 0.4.3 |
| `README.md` | Test count |

**Signature changes:** `base_coverage()` returns three values and accepts
`text_rows=`; `info_bar_cut()` takes `text_rows` as its second positional
argument. Both default to the safe behaviour. `run.py` is the only caller in
the engine — check the Hub for others.

Unchanged: thresholds, the rule table, PDF extraction, plate geometry, trap
logic, `TRAP_AT_NEGATIVE_SPACE`.

## 7. Your remaining points, accepted

- **Preserve historical inspections.** Agreed — apply to new and deliberate
  re-inspections only. The engine stamps `engine_version` on every result, so an
  old verdict stays readable in terms of the code that produced it.
- **Leave the trap rule alone.** Still out of scope. For the record, with the
  hardened detector it would move one fixture: `#22560 B` White 84.1% → 85.6%.
  Mint's call, not a tidy-up.
- **I have not reproduced your Hub environment.** The 57-file validation is from
  my corpus with MuPDF 1.23.10 and Ghostscript 10.02.1. Please run it yours.

---

*The review was right on every count and the fix is better for it. The live-text
condition in particular is not a patch over your counterexample — it is the
condition the detector should have been built on, and it took your example to
see that.*
