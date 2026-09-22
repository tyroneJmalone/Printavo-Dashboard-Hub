# Engine note 01 — MuPDF SVG dimension compatibility

**Re:** your baseline validation report · **Engine 0.4.0 → 0.4.1** · 22 Sep 2026

---

## Short version

Your diagnosis is correct and the way you handled it was right: you reproduced
it, found the actual cause rather than the one the failure message pointed at,
confirmed it was a real defect rather than a test artefact, and paused instead of
patching calibrated code. Thank you for that.

**Approved — but not the minimal patch.** It has a side effect that would have
replaced this bug with a worse one. There is also a second instance of the same
root cause that the failing test did not lead you to.

Both are fixed in 0.4.1, attached. Answers to your two questions are in §4 and §5.

---

## 1. Why the minimal patch is not safe

Your proposed regex matches correctly. The problem is four lines further down,
in what `compose_knockout` does with what it matched:

```python
f'width="{w}pt" height="{h}pt" viewBox="{vb}">\n'
```

The unit is re-emitted as a **literal**, not carried through from the input. So
on a 1.25.3 SVG the patched code reads `width="1152"` and writes back
`width="1152pt"`. Those are not the same size — 1pt = 1.333px — so every composed
plate renders 1.333× larger than an uncomposed one.

Reproduced here against `-22968 B OUTPUT.ai`:

```
                 input                              emitted
1.23 (pt)        width="1152pt" height="1296pt"  -> width="1152pt" height="1296pt"   ok
1.25 (unitless)  width="1152"   height="1296"    -> width="1152pt" height="1296pt"   1.333x
```

In today's call graph `ko` is per-artboard, so plates mostly compose or fail
together and the scale error stays uniform — which is exactly what makes it
dangerous. It would pass a visual check. It surfaces as *misregistration between
plates* the moment one plate composes and another doesn't (the
`is_well_formed(composed)` branch already allows that), and misregistration is
the thing this tool exists to detect. A preview defect that mimics the defect
under inspection is the worst available outcome.

**The fix is to stop round-tripping the dimensions at all.** The mask only needs
the viewBox. So 0.4.1 reuses the plate's own `<svg>` open tag verbatim and parses
viewBox separately:

```python
SVGLEN = r'[\d.]+\s*(?:pt|px|mm|cm|in|pc|em|ex|%)?'
WH = re.compile(rf'width="({SVGLEN})"\s+height="({SVGLEN})"\s+viewBox="([^"]+)"')
VIEWBOX = re.compile(r'viewBox="\s*([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)\s*"')

open_tag = SVG_OPEN.search(plate_svg_text)
vb = VIEWBOX.search(plate_svg_text)
if not open_tag or not vb:
    raise ChokeCompositionError(...)
x0, y0, vw, vh = vb.groups()
...
return (f'{open_tag.group(0)}\n'
        f'<defs><mask id="choke" maskUnits="userSpaceOnUse" '
        f'x="{x0}" y="{y0}" width="{vw}" height="{vh}">\n'
        ...)
```

This is narrower than your patch in effect even though it touches more lines: it
removes a class of bug rather than widening a match.

Verified — composing the same plate in both formats now yields **byte-identical**
mask and body, with each format's own unit preserved in the header.

## 2. The second instance you did not find

`run.py` line 45 carries the same assumption:

```python
SVGSIZE = re.compile(r'width="([\d.]+)pt"\s+height="([\d.]+)pt"')
```

On 1.25.3 this does not match, so `_save_svg` returns `w=0, h=0`. That feeds:

```python
if bb[2] > -1e8 and h:        # h is 0 -> art stays None
```

**Result: `previews[].art` is `None` on every file, and zoom-to-artwork silently
reverts to zooming into the middle of a mostly-empty 16″ board.** No error, no
test failure — your behavioural suite does not cover it.

Fixed with the same unit tolerance. Worth noting for its own sake: the pattern
here was never "one regex is too strict," it was "the engine parses the
renderer's output format in more than one place." If you find a third, that is
the reason.

## 3. Verification — done here, please repeat in your environment

```
17 passed, 0 failed, 0 skipped
13/13 golden records byte-identical to the pre-change baseline
```

The golden diff is the important one: `previews` is not part of the golden
record, so this confirms the change touches presentation only and no verdict,
status or completeness object moved.

New test: **"svg dimensions parse in both renderer formats."** It takes a real
underbase plate, derives the unitless variant, and asserts (a) both compose to a
mask, (b) each keeps its own unit, (c) the mask geometry is byte-identical
between them, and (d) an unreadable header raises rather than returning a plate.
That covers your "focused regression covering both dimension formats" and adds
the unit-preservation assertion, which is the part that would have caught the
minimal patch.

I also fixed the misleading diagnostic that cost you time. The test now checks
for `<mask>` **before** it checks the mask's colours:

```python
if "<mask" not in composed:
    return ("no <mask> in the composed plate - compose_knockout did not "
            "build one; check the renderer's SVG header format first")
```

The old message asserted a specific cause for a symptom with several possible
causes. That was a defect in the test, not just in its wording.

## 4. Your question: should an unsupported format raise?

**Yes. This is the more important of your two questions and you were right to
ask it.**

Silently returning an unmasked plate violates the engine's central principle.
The README's "things that look like bugs and are not" records that this exact
composition shipped wrong once already and was *invisible except by measuring* —
the plates looked perfectly fine, they were simply un-choked. Any code path that
can produce a plausible-and-wrong preview is a repeat of that bug.

0.4.1 raises `ChokeCompositionError`. But raising is only half of it — a raise
that aborts a run is not obviously better than a bad preview. It is caught in
`run.py` and recorded, so it travels with the result:

```python
"choked": bool(ko) and not choke_failed,
"choke_failed": choke_failed,        # ["1-160-Under: <reason>", ...]
```

and the viewer renders a strip above the plates:

> **Plates shown without their choke.** The choke mask could not be built for
> this file, so the plates below are drawn at full un-choked size. Do not judge
> trap from these previews — the numeric checks above are unaffected.

This is the same treatment the engine already gives an unevaluated rule: four
distinct non-judgement statuses exist so that nothing quietly covers for a gap.
A preview that cannot be trusted should say so in the same voice.

## 5. Your question: fix, or pin MuPDF?

**Fix. Do not pin.** Three reasons:

1. Your own results argue for it. 13/13 hashes, verdicts, statuses and
   completeness objects matched on 1.25.3. The measurement path — Ghostscript
   tiffsep, the perimeter-adjacency metric, every threshold — is version-stable.
   What differed was a serialization spelling in the preview path.
2. Pinning would have *hidden* this. The engine would have carried two
   spelling-fragile parsers indefinitely, and the next renderer change would
   produce the same silent degradation on someone else's machine.
3. A pin is a standing tax on the Hub environment for a defect that is now
   covered by a test.

`SYSTEM-DEPS.md` now lists both 1.23.10 and 1.25.3 as verified and says
explicitly not to pin.

One thing I would add, and would value your opinion on: a **startup capability
probe** — render a tiny known PDF once at boot and assert the SVG parses with the
dimension regex. That turns a silent runtime degradation into a loud startup
failure on any future renderer change, which is the property actually wanted
here. Not in 0.4.1; it is a Hub-integration-shaped decision and yours to place.

## 6. What changed in 0.4.1

| File | Change |
|---|---|
| `vector.py` | `WH` unit-tolerant; new `VIEWBOX`; `compose_knockout` reuses the plate's `<svg>` tag and raises `ChokeCompositionError` instead of returning unmasked |
| `run.py` | `SVGSIZE` unit-tolerant; catches `ChokeCompositionError`; records `choke_failed`; `choked` is now true only when composition actually succeeded |
| `build_site.py` | Gap strip when any artboard has `choke_failed` |
| `test_engine.py` | New dual-format test; `<mask>` presence checked before mask colours |
| `README.md` | New entry under "things that look like bugs and are not" |
| `SYSTEM-DEPS.md` | Both versions listed; explicit do-not-pin |
| `config.py` | `ENGINE_VERSION` → 0.4.1 |

Unchanged, as you proposed: PDF extraction, plate geometry, `MEASURE_DPI`, rule
thresholds, recolour-before-compose ordering, choke detection, mask geometry,
and `CHOKE_SAFE_FOR_DETAIL` stays disabled.

## 7. Acceptance for this change

Your list, with one addition:

1. ✅ 17 passed, 0 failed, 0 skipped
2. ✅ 13 golden verdict / status / completeness comparisons unchanged
3. ✅ Mask created, white background, black knockout strokes — both formats
4. ✅ **Mask geometry byte-identical between formats** (added)
5. ⬜ Visually verify a choked preview on your build before Hub integration —
   use **`-22906 LC OUTPUT 1.ai`**, artboard 2, ink `1-160-Under`

Item 5 is the one that matters most and it is the one I cannot do for you. When
this composition broke before, every automated check passed; it was caught by
eye, at 1600% zoom, by someone who knew what a choke should look like.

### Correction on the fixture — my error

I named `-22968 B OUTPUT.ai` and you were right that it is not in your bundle.
**You do not need a new file.** Use `-22906 LC OUTPUT 1.ai`, which is fixture 10
in `MANIFEST.json`, already SHA-pinned, already in your hands — and is both the
primary fixture of the existing knockout golden test and the actual file on
which the recolour-ordering bug was caught by eye. It is the better choice and I
should have named it.

Five of your thirteen fixtures have a choked base: `#22499 F`, `#21825 F1`,
`#22541 B REVISED`, `#22617 B`, `-22906 LC OUTPUT 1`, `-22906 LC OUTPUT 2` and
`-22771 LC`. `#22583 B` and `#22560 B` have an underbase with no knockout
strokes, so they will correctly show `choked: false` — that is not a failure.

**Expected magnitude:** the mask should remove on the order of 7–8% of the base's
ink area on `-22906 LC OUTPUT 1` — which is the same 7.6% figure the README
quotes for how much too large an un-masked base comes out. At high zoom the base
edge should sit visibly inside the colour above it, all the way round.

### Do not try to automate item 5 with an offline rasteriser

I attempted to give you a numeric version of this check and could not make it
reliable enough to hand over. The finding is worth having anyway, because it
would have cost you a day:

- **`mutool` ignores `<mask>` entirely.** It renders the composed plate at full
  un-choked size. So does **`cairosvg`**. Verified both against a trivial
  half-masked rectangle: each reported 100% of the shape visible where 50% was
  correct.
- **Chromium honours it correctly** (50% on the same test), which is why the
  viewer works.

So any offline measurement of the choke must drive a real browser, and a
screenshot harness comparing masked against un-masked plates gave me
inconsistent results across fixtures — on one file it reported the mask *adding*
ink, which is impossible and means the harness was wrong, not the mask. I am not
shipping a verification script whose failures I cannot trust; a flaky acceptance
gate is worse than an honest manual one. If you want to build that harness
properly it is worthwhile, but treat it as its own piece of work with its own
validation, not as a gate on this change.

The structural facts about the mask *are* asserted automatically, in the two
golden tests: the mask exists, its rect is white, its strokes are black and
0.75pt, and the geometry is byte-identical across both renderer formats.

---

*One process note: the report you sent was exactly the right shape — reproduce,
isolate, confirm it is real, propose narrowly, state what you are not touching,
and stop. Please keep raising things this way. The correction above exists
because you paused; it would not have been found if the patch had simply
landed.*
