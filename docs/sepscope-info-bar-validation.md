# SepScope information-bar correction

The reviewed 0.4.3 patch is merged selectively into the Hub engine. The withdrawn
archive was not installed. Existing October rules, renderer-format tests, rule
thresholds, and negative-space trap measurements are preserved.

Coverage excludes a top label block only when each candidate band is thin and
has a nearby live-text origin, with a gap of at least 0.10 inch before the next
artwork band. Without evidence it measures the full plate. Results record the
excluded row and explain whether labels were excluded. New results carry engine
version 0.4.3; saved inspections are not rewritten.

The real-file test requires the actual Brown ink in `-22771 LC OUTPUT.ai` to
exceed 85%, reports the excluded row, and requires the visible explanation.
It does not substitute a different fixture or pass when Brown is absent.

The supplied synthetic cases cover missing text evidence, unrelated text,
small artwork above larger artwork, crowded labels, and a recognized two-line
bar. The tests also check coordinate conversion and the separate live-artwork
text failure.

## Reproduce

```sh
python -m unittest discover -s artifacts/api-server/python/printscope-engine \
  -p 'test_consultant*.py' -v
python -m unittest discover -s artifacts/api-server/python \
  -p test_printscope_worker.py -v
```

The corpus test validates hashes for the bundled 13 fixtures and compares all
current rule statuses with whole-plate measurement on the same renderer. It
permits only the expected coverage flag-to-pass on `-22771 LC OUTPUT.ai`.
Historical golden results are still checked with whole-plate measurement;
the original golden files are not overwritten. Registration context is unchanged.
On 22771 LC, adding Brown to the based-ink set increases erosion shape counts
from 128/404 to 146/519 before/after erosion; vanished shapes remain zero.
This is an expected numeric change, not a choke verdict change. Other fixture
erosion measurements are unchanged. The corpus test also runs the 19 engine tests.

## Verification outcome

- All 13 SHA-pinned fixture comparisons passed on MuPDF 1.25.3 and Ghostscript
  10.05.1. Only the expected 22771 LC coverage rule status changed.
- All 19 engine tests passed, with zero failures or skips.
- All 19 additional consultant-rule tests and seven worker boundary tests passed.
- API build and startup succeeded; the worker probe reports engine 0.4.3.
- The public Hub sign-in screen loaded. Authenticated inspection UI was not
  browser-tested; the existing rule-detail renderer displays the new explanation.

## Remaining validation limits

The consultant's 57-file corpus is not bundled here; their measurements are not
independently reproduced by this test. A thin artwork band at the same vertical
position as live text remains an acknowledged detection ambiguity. Live text
inside the artwork bounding box is separately reported; that is not proof every
possible ambiguous layout is caught. More-than-five-ink layouts remain outside
the consultant's measured corpus.
