# PrintScope — Phase 0 Findings

**Four real seps.io files + Pre-Press Pro V1.1, read directly. Sept 2026.**

Phase 0 of the build plan is done. Everything below is measured from your files,
not assumed. Several things in the original plan were wrong; this document says
which, and why.

Files read: `#19038 F OUTPUT.ai`, `#22499 F OUTPUT.ai`, `#22834 B OUTPUT.ai`,
`#22880 LC OUTPUT.ai`, `Pre-Press Pro V1.1.jsx`.

*(You referenced 22835 for the 5-colour; the file in the folder is 22834.)*

---

## The headline

**All four files are PDF-compatible and fully machine-readable.** Every rule you
described is verifiable — and the two hardest ones turned out to be *easier* than
planned, not harder. But three assumptions in the v1 plan were wrong in ways that
would have produced a tool nobody trusted.

| | |
|---|---|
| ✅ | Format risk is zero. 4/4 parse. Illustrator 29.8 and 30.4/30.7, `%PDF-1.5`. |
| ✅ | Choke is **exactly verifiable in vector space**. No raster measurement needed. |
| ✅ | Your swatch naming is **structured and parseable** — far better than an allowlist. |
| ❌ | "Flag multi-artboard files" — wrong. Multi-artboard is your normal. |
| ❌ | "Flag live text" — as written, would false-positive on **100% of files**. |
| ❌ | "Spot names against an approved list" — unworkable. Ink names are per-job. |

---

## 1. File structure

| File | Artboards | Trim size | Illustrator | Inks (excl. `All`) |
|---|---|---|---|---|
| 19038 F | 1 | 16.00 × 11.42 in | 29.8 | 1 |
| 22499 F | 2 | 16.00 × 9.81 in | 30.4 | 3 |
| 22834 B | 1 | 16.00 × 15.89 in | 30.7 | 5 |
| 22880 LC | 2 | 16.00 × 3.85 in | 30.7 | 3 |

Ink counts match your descriptions exactly, **once `All` is excluded**. `All` is
the Illustrator Registration swatch (DeviceCMYK 1,1,1,1) and appears in every
file on every artboard.

→ **Rule: plate count = unique colorants across *all* artboards, minus `All`.**
Validated 4/4.

Note the width: all four are exactly 16.00 in. That's your film width, not the
print size — so an artboard-size rule must measure the *artwork* bounds, not the
artboard.

---

## 2. Swatch naming is structured — this changes the rule set

Actual swatch names from the files:

```
1-160-Under                     5-230-Grey 428 C        10-230-Black
5-200-Drake Red 2035            10-200-White            1-230-Red 7416 C
5-230-Green 4505 C              6-230-Blue 5493 C       10-230-Brown 7601 C
4-230-Cream 7508 C              1-160 & 10-160-White & Black
```

The pattern is **`{head}-{mesh}-{ink name}`**. Head position, mesh count, ink.

This is much better than the approved-list approach in the plan, which can't work
— `Drake Red 2035` and `Green 4505 C` are per-job and unlistable. Instead:

- **Validate the structure** with a regex. Catches malformed names with no list
  to maintain.
- **Allowlist only the role keywords** in the third segment: `Under`, `White`,
  `Black`.
- **Derive facts from the structure**: head positions (no duplicates), mesh
  counts, and — usefully — the underbase's mesh vs the colours'.

Observed: underbase always runs `1-160` (head 1, 160 mesh); colours run 200–230.
Coarser mesh for the base, exactly as expected. That's a checkable rule you never
have to write down twice.

19038's `1-160 & 10-160-White & Black` is a compound name — one film, two heads,
print white on darks or black on lights. The regex needs to tolerate it.

---

## 3. Underbase detection — two independent signals

Your Rhodamine Red convention is confirmed in the file data, and it's exact:

```
1-160-Under   →  alternate DeviceRGB (0.899, 0.022, 0.584) = RGB 229, 6, 149
```

**Byte-identical in both files that have an underbase.** That's a reliable second
signal alongside the name ending in `-Under`.

And your Green 0921 convention likewise:

```
10-200-White  →  alternate DeviceRGB (0.600, 0.901, 0.846) = RGB 153, 230, 216
```

→ **Rule: detect role by name suffix AND by display colour. If they disagree,
`could_not_evaluate`.** Free cross-check, no extra work.

One parser note: 19038 (Illustrator 29.8) uses an **ICCBased** alternate space
where the 30.x files use **DeviceRGB**. The extractor has to handle both — file
structure varies by Illustrator version, and you have both in production.

---

## 4. The choke — fully characterised, and simpler than planned

This was the biggest unknown. It's now completely solved.

Here is the actual content stream around a choke stroke in 22499:

```
0 0 0 0    K       ← stroke colour: DeviceCMYK zero = NO INK (knockout)
0.75       w       ← 0.75pt
...path...
           S       ← stroke
```

So the mechanism is: **the underbase artboard holds a copy of each top-colour
shape, filled in the `Under` separation, with a 0.75pt centre-aligned
zero-ink stroke that eats the edge inward.**

Then I matched every choke stroke's path geometry against the top-colour fills on
the other artboard:

```
22499  →  11 choke strokes, ALL 0.75pt.  Matched to 11 fills of '5-230-Grey 428 C'.
          Bounding-box delta: 0.0 pt.
22880  →   7 choke strokes, ALL 0.75pt.  Matched to  7 fills of '5-200-Drake Red 2035'.
          Bounding-box delta: 0.0 pt.
```

Zero delta. The choked paths are exact copies of the top-colour paths.

And the negative cases confirm your rule precisely:

- 22880's **47 White fills → 0 choke strokes.** Matches "underbase beneath a
  white does not require any stroke."
- 22499's **37 Black fills → 0 choke strokes.** Black on a dark garment takes no
  base at all.

### What this means for the build

**Delete the raster choke measurement from v1.** The plan proposed distance
transforms at 1200 dpi with half-pixel bias correction. Unnecessary. The check is
exact, in vector space:

> For each top-colour fill on the colour artboard whose ink requires a base:
> 1. find the geometrically identical path on the underbase artboard
> 2. assert it's filled with the `Under` separation
> 3. assert it carries a 0.75pt stroke in a zero-ink colour

Deterministic, exact, fast, no Ghostscript in the rule path at all. Raster
measurement survives only as a fallback for files that don't follow this
structure.

It's also a far **better** rule than "is there a 0.75pt stroke in this file",
because it's per-object — it catches the real failure mode, which is seps.io
missing the choke on one shape out of eleven.

### Two things to confirm with your artist

**a) Centre-aligned means the geometric choke is 0.375pt, not 0.75pt.** Half the
stroke sits outside the path edge and half inside, so a 0.75pt centre stroke pulls
the underbase in by 0.375pt. The spec and the effect are different numbers. The
rule config needs to store stroke width *and alignment* separately — the original
schema had no alignment field. Worth confirming that 0.375pt inward is what you
actually intend.

**b) Black took no underbase in 22499.** I've read that as "black on a dark
garment needs no base." If the real rule is different, say so — it changes when
`UNDERBASE_REQUIRED` should fire.

---

## 5. Your Illustrator script adds live text to every file

`Pre-Press Pro V1.1.jsx` is a registration-marks and swatch-labelling script. On
every artboard it adds, onto a layer named **`Reg Marks & Info`**:

- registration marks (placed and embedded from `topcentremark.ai` etc.)
- the **filename, as live point text**, 14pt, in the Registration swatch
- the **swatch label report, as live point text**, one line per swatch, each line
  coloured with its own swatch
- a halftone range bar
- then fits the artboard to art and adds 7pt padding

The filename and the swatch report are created with `textFrames.pointText()` and
**never outlined**. Confirmed in the files:

```
19038   live text ops: 3      22499   3 + 2      22834   8      22880   3 + 2
font:   MyriadPro-Regular (embedded, subset)  — all four files
```

So the rule as written — *"all fonts should be outlined, any live fonts
flagged"* — would flag **4 out of 4 good files**. That's the exact failure mode
that gets a tool ignored in week two.

### The fix, and it's the most important finding here

Illustrator layers survive into the PDF as optional content groups, and they
attribute cleanly. Every file has the same structure:

```
Guides  ·  Koozie Guides  ·  PASTE ART HERE  ·  Reg Marks & Info
```

Attributing every operation to its layer:

| File / artboard | `PASTE ART HERE` | `Reg Marks & Info` |
|---|---|---|
| 19038 | 0 live text, 16 objects | 2 live text |
| 22499 ab0 / ab1 | 0 / 0 live text, 48 / 59 objects | 3 / 2 live text |
| 22834 | 0 live text, 3063 objects | 8 live text |
| 22880 ab0 / ab1 | 0 / 0 live text, 58 / 65 objects | 3 / 2 live text |

**Zero live text in `PASTE ART HERE` across all four files, every artboard.** The
art is properly outlined. All the live text is your own script's.

→ **Every art rule must scope to the `PASTE ART HERE` layer.** Scoped:
0 false positives, 4/4. Unscoped: 100% false positives, 4/4.

This applies well beyond text — `Reg Marks & Info` and `Guides` would otherwise
pollute artwork bounding boxes, plate coverage, and print-size checks too.

**Layer scoping is now the central architectural requirement of the parser**, and
it wasn't in the plan at all.

### One more thing about the script

It has **no choke or underbase logic whatsoever** — it's purely marks, labels and
artboard fitting. So nothing at Mint currently enforces the 0.75 choke
automatically. That's precisely the gap PrintScope fills, and it's a cleaner
argument for building than the one in §9 of the plan.

Also: the script's own "Rename Swatches" feature writes names as
`LABEL -- inkname` with a hardcoded ` -- ` separator, which does **not** match
your actual `{head}-{mesh}-{ink}` names. So your naming is being applied manually
or elsewhere. Worth knowing — if you ever wanted the script to enforce naming,
that separator is hardcoded and would need editing.

---

## 6. Corrections to the build plan

| Plan said | Should say |
|---|---|
| `DOC_SINGLE_PAGE` — flag multipage files | **Delete.** Multi-artboard is normal; the underbase lives on its own artboard. |
| `SPOT_NAMES_APPROVED` — allowlist every swatch name | **Replace** with structural regex + role keywords. Ink names are per-job. |
| Choke measured from raster at 1200 dpi | **Exact vector check.** Geometry match + 0.75pt zero-ink stroke. Raster is fallback only. |
| Underbase named `White Base` | It's `1-160-Under`, cross-checked by Rhodamine Red display colour. |
| Facts document is per-file | Must be **per-artboard and per-layer**. |
| Plate isolation needed for the rule engine | Needed only for **UI previews**. Rules never touch Ghostscript. |
| Stroke rules store width only | Need a **stroke alignment** field (centre → 0.375pt effective). |
| `TEXT_OUTLINED` on the whole file | Scope to `PASTE ART HERE`. |

Parser corrections found while extracting:

- **Graphics state inherits into Form XObjects.** My first pass reset line width
  and colourspace on recursion and lost every stroke's colour. Real bug, would
  have silently under-reported.
- **Stroke colour is set with `K`, not `CS`.** Illustrator uses the implicit
  `K`/`G`/`RG` operators. A parser watching only `CS`/`SCN` finds nothing.
- **ICCBased vs DeviceRGB alternates** vary by Illustrator version (see §3).

---

## 7. New requirements captured

From your notes, now folded into scope:

1. **Display image size, swatch names, and swatch stroke detail** — the stroke
   detail is per-swatch and per-object, and §4 shows it's available exactly.
2. **Multi-artboard viewer with per-artboard show/hide toggles, layered in
   register.** All artboards in your files share the same trim size and
   coordinate origin, so they overlay directly with no alignment maths. This is
   also the natural UI for showing a choke: toggle the underbase under the
   colour artboard and look at the edge.
3. **Live-font flagging** — scoped per §5.

On (2): since artboards overlay in register, the same toggle view gives you the
underbase-vs-colour comparison for free. Worth building early — it's the one
screen that makes a non-designer able to *see* what the verdict is talking about.

---

## 8. What I'd do next

1. **Confirm the two open questions in §4** — the 0.375pt effective choke, and
   whether black genuinely takes no base.
2. **Get a known-bad file.** Still the single most valuable missing asset. Four
   good files prove the parser reads correctly; they can't prove the rules catch
   anything. One rejected file does more than ten good ones.
3. **Widen the corpus** toward the messy end: a halftone/simulated-process job, a
   file with a placed raster image (none of the four have one, so the image-size
   and dpi rules are still completely untested), and a job from a different
   seps.io operator to see whether the naming convention holds.
4. Then Phase 1 — author the rule catalog against the corrected CSV.

The revised rule catalog is in `printscope-rules-v2.csv`, alongside this.

---

# Addendum — file #91825, and a second trap technique

**Added after a fifth file landed in the PrintScope folder.** This one broke two
rules as written, and it is not a bad file.

`#91825 F OUTPUT.ai` · Illustrator 30.8 · 2 artboards, 16.00 × 7.93 in · 3 inks +
underbase · same four layers, art properly outlined.

## 1. seps.io uses two different trapping techniques

The four original files all did the same thing. This one does the opposite, and
achieves the identical result.

| | Technique A — *choke the base* | Technique B — *spread the colour* |
|---|---|---|
| Seen in | 22499, 22880 | **91825** |
| Stroke lives on | underbase artboard | **colour artboard** |
| Stroke colour | zero-ink CMYK (`0 0 0 0 K`) | **the shape's own ink at full tint** |
| Effect | base pulled in 0.375 pt | **colour pushed out 0.375 pt** |
| Underbase geometry | choked copy of colour art | **exact 1:1 copy, untouched** |

Both are 0.75 pt centre-aligned. **Net trap on press is the same 0.375 pt
overlap.** These are two routes to one result.

Measured on 91825:

```
205 colour fills · 205 underbase fills   (base is a 1:1 copy of the art)
161 strokes, all 0.75pt, each in its own spot colour at tint 1.0
161/161 strokes match a fill of the SAME colorant   — bbox delta 0.00pt
161/161 non-white colour fills have an exact underbase match — median delta 0.000pt
 43 White fills → 0 strokes                         — white excluded, as specified
```

The systematic completeness — 161 of 161, white correctly excluded — says this is
deliberate technique, not a missed step.

**Impact:** `UNDERBASE_CHOKE_PER_OBJECT` as written looks for zero-ink strokes on
the underbase artboard. On this file it finds none and **fails a correct file.**
A false-fail destroys trust just as fast as a false-pass. The rule now accepts
either technique and verifies the net trap.

Added `TRAP_TECHNIQUE_CONSISTENT` (flag): a file should use one technique
throughout. A mix usually means a pass was missed.

## 2. Rhodamine Red is also a real ink

This file carries `6-230-Rhodamine Red C` — an actual printing ink on head 6 —
whose display alternate is **RGB 229, 6, 149. Byte-identical to the underbase
proxy colour.**

So `UNDERBASE_ROLE_AGREES`, which cross-checked name against display colour,
would now assign the underbase role to a real ink.

**Corrected precedence: the name decides.** The underbase is the swatch whose ink
segment reads `Under`. Rhodamine Red display colour is corroborating evidence for
a swatch already named as the base — never sufficient on its own.

A useful reminder that a "free cross-check" is only free until the corpus grows.

## 3. What this file confirms

- Naming convention holds — 4/4 structured, including a PMS-named ink
- `10-230-White` displays as Green 0921 (153, 230, 216), as specified
- Layer structure identical; **0 live text on `PASTE ART HERE`** (5/5 files now)
- Registration `All` present on both artboards
- Underbase on its own artboard again (3 of 5 files now)

## 4. Still missing

**No placed raster.** Five files, zero images — `IMAGE_MIN_DPI`,
`IMAGE_HARD_MIN_DPI` and `IMAGE_NOT_RGB` remain completely untested.

**Still no known-bad file.** Though 91825 delivered something nearly as valuable:
a *false-fail* caught before it could be built.

## 5. Open question for Tyler

Is Technique B acceptable, or is 91825 wrong?

The evidence says deliberate — 161 of 161, white correctly excluded. But that is
a judgement about shop standards, not something the file can answer. If both
techniques are acceptable, the updated rule is correct as written. If only
choke-on-base is acceptable, then this file should fail and the rule should say
so.

---

## Addendum 2 — why there are two techniques, and how to check it

Tyler: *both methods are accepted, and which one is correct depends on the art.
If an underbase contains very small detail, a choke makes it disappear entirely —
leaving nothing for the top colour to print on, so that colour reads duller than
the same colour where a base exists underneath.*

That is a production rule, and it turns out to be **measurable from the file.**

### The test

Take the underbase geometry, erode it by 0.375 pt — the actual effect of a
0.75 pt centre-aligned choke — and look at what happens topologically:

- **components that vanish entirely** → base erased under small features
- **component count that *increases*** → shapes fragmenting where thin bridges
  are severed. This is the more sensitive signal.

Anything under 0.1 sq pt is ignored as antialiasing noise.

### Result — 3 of 3 match the technique seps.io actually chose

| File | Technique used | Components under a 0.375 pt choke | Vanished | Verdict |
|---|---|---|---|---|
| 22499 | A — choke base | 12 → 12 | none | safe to choke ✅ |
| 22880 | A — choke base | 60 → 60 | none | safe to choke ✅ |
| **91825** | **B — spread colour** | **191 → 214** (23 fragments) | **2** (0.69, 0.50 sq pt) | **choke would damage it ✅** |

The two files seps.io choked are topologically robust. The one they spread has
art that fragments badly under a choke and loses two small features outright.
**Their technique choice was correct in all three cases, and the metric predicts
it.**

One caveat on method: for the technique-A files the base is *already* choked, so
that test measures whether a *second* choke would hurt. For 91825 the base is an
unmodified 1:1 copy, so it is a true simulation — and it is the case that matters.

### Why this belongs in the tool rather than in a person

The failure mode is nearly invisible on screen. A 0.5 sq pt piece of missing
underbase is not something anyone spots by eye in a plate — but on press it shows
as a patch of the same ink reading duller than the rest of the print. A human
inspecting the file would have to know to look for it, at that scale, in every
small feature.

Erosion topology catches it in about a second.

Added as `CHOKE_SAFE_FOR_DETAIL` (flag, fires only when technique A is used).
Its `illustrator_action` is `prefer_technique: spread_colour` — so the future
prepress-automation project reads the same row and knows which method to apply.

### And it rescues the raster pipeline

Addendum 1 concluded that raster measurement could be deleted, since trap
verification is exact in vector space. That stands — but morphology on the
rendered plate is the *right* tool for this rule, and it reuses the Ghostscript +
scipy work already proven in Phase 0. Keep it; it is no longer only a fallback.

---

## Addendum 3 — the first planted-error test, and a rule that failed it

Tyler nudged the underbase artboard of `#21825 F1 OUTPUT.ai` **one arrow-key click
to the right** before saving, to see whether the tool would catch it.

**It did not.** The Checks panel reported *"Artboards in register — PASS."*

### Why the rule was wrong

`ARTBOARDS_REGISTERED` compared **artboard trim size and origin**. Both artboards
are 16.00 × 7.30 in with the same origin, so the check passed — correctly, for
what it was measuring. It just wasn't measuring registration.

Registration is a property of **the artwork**, not the artboard. Worse, the
earlier per-edge inset metric averaged it away: a pure translation shows as +1 pt
on one edge and −1 pt on the opposite, which medians to zero. The signal was in
the data the whole time and the summary statistic erased it.

### The replacement

Match art-layer shapes across artboards **by size**, then take the median
translation between matched pairs. A rigid shift shows up immediately; a trap
does not, because a trap changes size, not position.

| File | Shapes matched | Median offset | Verdict |
|---|---|---|---|
| 22499 | 48 / 48 | 0.000 pt | in register |
| 22880 | 54 / 54 | 0.000 pt | in register |
| 91825 | 355 / 365 | 0.000 pt | in register |
| **21825** | **126 / 126** | **1.000 pt in x** | **out of register** |

Exactly 1.000 pt — Illustrator's default keyboard increment. The per-shape spread
is 0.088, confirming a rigid translation rather than noise.

Added as `ARTWORK_IN_REGISTER` (fail). `ARTBOARDS_REGISTERED` survives but is
renamed *"Artboards share trim size and origin"* and its description now says
explicitly that it does **not** verify artwork alignment.

### Why this one matters more than it looks

**The registration marks still line up perfectly.** They are placed per-artboard
by Pre-Press Pro, so nudging the artwork leaves them untouched. A press operator
registers to the marks, sees them align, and prints — with the base 1 pt off
under every colour.

So this defect is invisible at exactly the two moments someone would catch it: on
screen, where the marks look right, and at the press, where the marks *are* right.

The viewer now shows the offset in the ruler bar — **⚠ out of register 1pt** — in
red, next to the plate count.

### What the test proves about the method

One deliberately planted error found a false pass in a rule that had been
"validated" against four good files. Four passing files could not have found it;
one broken file did, in a minute.

This is the entire argument for §6c of the build plan. Planted errors are not a
nice-to-have — they are the only thing that tests a rule's *sensitivity* rather
than its agreeableness.

---

## Addendum 4 — four planted defects, scored honestly

Four files, one planted defect each, nothing disclosed in advance.

**Score: 1.5 of 4.**

| File | Planted defect | Result |
|---|---|---|
| 21797 | No trap at all under the red | ✅ **found** — reported, though hedged |
| 22563 | Grey stroke around a navy fill | ⚠️ **half** — saw the 0.1 pt stroke, missed that fill and stroke are different inks |
| 22829 | An orange that is not a spot swatch | ❌ **missed** — saw `None: 3` unresolved fills and did not investigate |
| 22875 | Brown out of register, now under the blue | ❌ **missed** — called the file clean |

The two misses are the useful part.

### 22829 — the miss I walked straight past

My own output said `fills: {..., None: 3}` and I did not ask what those three were.
One of them is the orange: an **ICCBased CMYK** fill at C 0.024 M 0.663 Y 0.690 K 0.
Not a separation, not named, will not plate.

The rule this produces is better than the one it replaces. `NO_RGB_ART` enumerated
forbidden colour spaces; the correct rule inverts it:

> **Every painted object on the art layer must use a `/Separation` or a
> `/DeviceN` of separations.** Everything else — ICCBased, DeviceCMYK, DeviceRGB,
> DeviceGray — is unconverted art. The only exception is the `0 0 0 0` knockout.

Renamed `SEPARATION_ONLY_ART`. An allowlist of legitimate spaces cannot be
outflanked the way a blocklist can.

### 22875 — a hypothesis that had to be killed

Brown is head 10, so it prints last and sits on top. In the file it is drawn
*first*. That looked like a clean rule: **stacking order should match head order.**

It is not a rule. Checked across all nine files, draw order matches head order in
only 3 — and the mismatches include known-good files. The signal does not exist.

What does work is **pairwise ink overlap**. In a separation file inks knock out
rather than overlap; the only legitimate overlap is a thin trap band. Rasterise
each plate and measure the maximum inscribed width of each pairwise intersection:

| File | Worst overlap width | |
|---|---|---|
| 22834 (good, 5 colour) | 1.07 pt | trap bands |
| 91825 (good) | 1.36 pt | trap band, 0.0% area |
| **22875 (planted)** | **2.40 pt** | **solid overlap** |

It detects the defect, but 1.36 against 2.40 is not much daylight. Logged as
`INK_OVERLAP_NOT_TRAP` and **explicitly marked as needing tuning** — nine files
is not enough to set that threshold.

This is also a case `ARTWORK_IN_REGISTER` structurally cannot catch: that rule
compares artboards, and 22875 has only one.

### 22563 — right observation, wrong reason

I reported two strokes at 0.1 pt as below the minimum stroke weight. True, but not
the point. Those two paths are **filled in `5-230-Blue 286 C` and stroked in
`6-230-Gray 432`** — different inks on the same object.

Tyler's reasoning is what makes it a rule: the underbase is built from the fill,
so a stroke in another ink extends past the base with no trap under it. A
measurement I had in hand, whose significance I missed.

New rule `FILL_STROKE_SAME_COLORANT` (flag).

### 21797 — found, and now specified properly

Reported correctly: 2,659 red shapes over a pixel-exact 1:1 base, no trap by any
mechanism. Tyler's refinement makes it precise rather than blanket:

> A based colour needs a trap where its perimeter **abuts negative space**. It
> does not need one where it is entirely enclosed by a colour that is itself
> fully knocked out of the base.

`TRAP_AT_NEGATIVE_SPACE` (fail) replaces the blanket version.

### What the exercise says about the method

Four planted defects produced four rules, two of which corrected rules I had
already "validated" against good files, and one of which killed a plausible
hypothesis before it shipped.

Nine good files could not have produced any of them. The ratio of information to
effort here is not close — **a deliberately broken file is worth roughly ten
correct ones**, and §6c of the build plan should be read as the primary
validation activity rather than a checklist item.

Also worth stating plainly: the tool found 1.5 of 4 unaided. That is the honest
baseline for what the rule catalog catches today, and the number the pilot's
disagreement rate should be measured against.

---

## Addendum 5 — second planted round: 1 of 4, and two false positives

Worse than the first round, and for a more interesting reason. Three of the four
"anomalies" I reported were **legitimate production techniques I had never seen**,
and the one real defect was sitting in data I had already printed.

| File | Reported | Truth | |
|---|---|---|---|
| 22699 | fail — "one head, two inks is impossible" | **ink change** mid-run | ❌ false positive |
| 22617 | anomaly — "an artboard with one object" | **gradient blend technique** | ❌ false positive |
| 18496 | flag — 0.25 pt chokes on a white-only job | **trim residue** — worth flagging | ✅ correct |
| 22554 | "can't call it" | **Gold declared, never used** | ❌ missed |

### The false positives are the important half

My most *confident* call of the round — `5-200-Grey 429 & Yellow 121`, "one head
cannot print two inks" — was exactly backwards. It is an **ink change**: the press
stops mid-run, one ink is cleaned out, the other loaded, for a second colourway.
The naming convention encodes a production instruction I had read as a
contradiction.

Three compound forms, all valid:

| Form | Meaning |
|---|---|
| 2 heads, 1 ink | same art on two screens — double-hit white, or varying mesh |
| 2 heads, 2 inks | one film, two garment colourways |
| **1 head, 2 inks** | **ink change mid-production** |

`SWATCH_NAME_STRUCTURE` now documents all three and fails none. Added
`INK_CHANGE_DECLARED` (info) so scheduling and the press see it.

22617 was the same error in a different costume: an artboard I called near-empty
is a deliberate **gradient blend**, with one colour run further beneath the other
so the transition needs no impeccable registration.

**A tool that fails unfamiliar-but-correct work is worse than no tool.** Two
rounds in, my false-positive rate is the bigger problem, not my miss rate.

### A real parser gap, found by being wrong

22617 exposed something the "one object" reading was hiding: **the extractor is
blind to gradients.** Illustrator paints them with the `sh` shading operator, and
I was only counting `cs` + fill.

```
22617 AB0: 23 sh ops — Separation shadings in Yellow 108 C and White
22617 AB1: 23 sh ops — Orange 158 C, Blue 7688 C, Cool Gray 11 C
```

I reported that file as having 5 inks. It has **7**. Orange 158 and Blue 7688
exist only inside shadings and were invisible to every rule.

Any rule counting plates, coverage or ink usage was silently wrong on any file
with a gradient. Fixing the extractor to walk `/Shading` resources and count `sh`
is now a prerequisite, not a refinement.

### 22554 — the miss, and the check that would have caught it

`5-230-Gold 110 C` is declared in `/ColorSpace`, listed in the swatch label block,
and **painted nowhere**. A screen burned for a colour that isn't in the design.

`NO_EMPTY_PLATES` existed for exactly this. It didn't fire because I compared
nothing — I printed the colorant list and the fill counts in the same output and
never diffed them. Same failure as 22829: the evidence was on screen, unexamined.

The rule now explicitly compares **declared** against **painted**.

### The swatch label block is a manifest — and it's readable

Chasing this produced something better than the rule itself. Pre-Press Pro writes
the swatch list as **live text**, so it can be extracted:

```
#22554 F OUTPUT.ai
1-230-Blue 646 C   5-230-Gold 110 C
6-230-Pink 7612 C  7-230-Red 7598 C
10-230-Brown 4625 C
```

That gives **three independent views** of the same list — what the label says,
what the file declares, and what is actually painted. 22554 agrees on the first
two and fails the third, which is precisely the signature of a dropped colour.

It is also the list the press operator reads, so when it disagrees with the
artwork, that matters on its own. Added as `SWATCH_LABEL_MANIFEST`.

Note the dependency: this works *because* the label text is live. The rule that
scopes `ART_TEXT_OUTLINED` to `PASTE ART HERE` is what keeps it that way.

### Green / yellow / red

Tyler's suggestion, adopted. The catalog already carried three severities; the
misses above are what make the middle one load-bearing.

| | | |
|---|---|---|
| 🟢 `pass` | correct | release |
| 🟡 `flag` | **judgement call** | a human decides — trim residue, ink change, gradient blend, near-miss naming |
| 🔴 `fail` | wrong | hold |

Current catalog: **18 fail, 15 flag, 3 info.** Both rounds of false positives were
rules pitched at red that belonged at yellow. When in doubt, yellow — a flag costs
ten seconds of attention, a wrong red costs the tool's credibility.

---

## Addendum 6 — the trap invariant is the SUM, and 21825 was right

Tyler, from a floor conversation: *depending on the nuance of the artwork we may
choke the underbase less than usual and then spread the top colour less than
typical, for a net result of familiarity. Under choked 0.5 and colour spread 0.25,
or under choked 0.1 and colour spread 0.65.*

Both examples sum to **0.75**.

So the rule was never "one technique at 0.75 pt". It is:

> **choke_pt + spread_pt = 0.75 pt**, per shape pair — a 0.375 pt net trap,
> however the work is divided between the two plates.

Technique A is the 0.75 + 0 case. Technique B is 0 + 0.75. Everything in between
is a **split trap** and equally correct.

### Which means #21825's trap was correct, and I flagged it wrongly

That file reported as:

```
colour artboard : 13 spread strokes @ 0.75pt   +   8 spread strokes @ 0.25pt
underbase board :                                  8 choke  strokes @ 0.50pt
```

I called it *"mixed techniques, and 8 of 21 shapes trapped at the wrong width"* —
a **fail**. It is neither.

Matching the 0.25 pt spreads against the 0.50 pt chokes by geometry:

```
8 / 8 matched — bbox delta 0.000 pt
0.25 + 0.50 = 0.75 pt
```

Tyler's first example, exactly. Every one of the 21 Blue shapes reaches full
trap: 13 by pure spread, 8 by a split.

**The planted misregistration was hiding it.** The first pass compared bounding
boxes across artboards and got a constant delta of 2.0 — two x-edges off by 1.0 pt
each, which is the deliberate 1 pt nudge. Remove that offset and the geometry is
identical to the hundredth of a point.

Two defects interacting produced a third apparent defect that did not exist. Worth
remembering: **when one fault is confirmed in a file, re-run the other checks with
it compensated**, or it will manufacture false positives downstream.

### Running tally of false positives

| Round | Called wrong | Actually |
|---|---|---|
| 21825 | trap at the wrong width | split trap, sums to 0.75 |
| 22699 | one head two inks — impossible | ink change mid-run |
| 22617 | artboard with one object | gradient blend technique |

Three false positives, all the same shape: **a rule pitched at red that encoded
one way of doing something as the only way.** Every correction has made the rule
more general and less specific about method — check the outcome, not the recipe.

`UNDERBASE_CHOKE_PER_OBJECT` now sums the pair and tolerates any split.
`TRAP_TECHNIQUE_CONSISTENT` is demoted from flag to **info** — it reports what the
file does rather than judging it.

---

# Addendum 7 — the 2021–23 historical batch (15 files)

*Fifteen files spanning invoices #9945 → #13843, filename dates 2021–2023. These
are the first files in the corpus that predate the current convention, and they
change what the rule table can safely assume.*

## 7.1 The headline: most of these files have no trap at all

Every stroke in all 15 files, with Form XObject recursion, resolved to the page
coordinate system:

```
#11443 RS BN     0.75pt × 21        ← trapped
#11556 RS BN     0.75pt × 14        ← trapped
#13440           0.75pt × 16        ← trapped
all 12 others    no strokes anywhere
```

The obvious next question is whether the trap was *baked into the geometry*
instead — an offset path expanded to a fill, which leaves no stroke to find. It
was not. Comparing the union bbox of the colour inks against the underbase ink,
restricted to `PASTE ART HERE`:

```
#11443 F    delta 0.000pt      #11758 F    delta 0.000pt
#11556 F    delta 0.000pt      #13843 F    delta 0.000pt
#9945  F    delta 0.001pt      #13440      delta 0.001pt
```

The underbase is a 1:1 copy of the colour art with nothing removed and nothing
added. **These jobs were separated without trap.**

Note that 1:1 geometry is also what a *correctly* choked modern file shows —
the choke is a zero-ink knockout stroke, so the fill geometry stays 1:1 and only
the stroke differs. Bbox equality alone never proves absence of trap. It is the
combination of identical bboxes *and* zero strokes that does.

**Consequence for the rule table:** run today's trap rules against this batch and
8 of 15 files throw a red fail. If PrintScope is ever pointed at the archive —
for reorder lookup, for training data, for the generator's corpus — it needs an
era gate, or those rules need `applies_when` narrowed to files carrying the
modern structural markers.

An oddity worth Tyler's read: the three files that *are* trapped are the two
sleeve prints and #13440 — the simplest jobs in the batch, one colour over base.
The four-colour fronts are the untrapped ones. That inverts the expected order.

## 7.2 Structural marker: no `Koozie Guides` layer

All 15 have exactly:

```
['Guides', 'PASTE ART HERE', 'Reg Marks & Info']
```

No `Koozie Guides` layer, which is present in most 2025–26 files. That is a
clean, cheap era discriminator — one dictionary lookup — and it is the obvious
candidate for the `applies_when` gate §7.1 needs.

## 7.3 Mesh is not a function of the artwork

This is the most useful thing in the batch, because it speaks directly to the
generator's largest open question.

`#11443 F`, `#11556 F` and `#13843 F` are the **same artwork** — identical ink
sets, identical art bbox to the thousandth of a point:

```
[252.569, 35.453, 912.235, 490.772]
```

Three separate invoices of one design. The green changed mesh between them:

```
#11443 F     6-160-Green3435
#11556 F     6-230-Green3435
#13843 F     6-230-Green3435
```

Same art, same ink, same head, different mesh. And within a single job, `#11302`
puts the same grey on two meshes depending on location:

```
#11302 B     1-110-Grey 429 C     full back,  16.0 × 13.60 in
#11302 LC    1-160-Grey 429 C     left chest, 16.0 × 5.41 in
```

The coarser 110 goes on the large print, the finer 160 on the small one — which
is a sensible rule and may well be *a* rule. But the three-invoice case above
shows mesh also drifts across time for identical art.

> **Mesh is not derivable from the art alone.** It is at least partly operator
> judgment or screen availability. A generator must treat mesh as an input, not
> a computed value — or accept that it will disagree with the artist and be
> right to.

This does not kill the generator; it sizes the human input precisely. Head and
mesh are one line of job setup, not a per-shape decision.

## 7.4 Head 1 is "first head down", not "the underbase"

`#11302` and `#13493` are single-artboard jobs with no base, and both assign head
1 to a colour:

```
#11302 B     1-110-Grey 429 C, 10-160-Maroon 188 C
#13493 B     5-160-Grey 429 C, 10-160-Maroon 188 C
```

So `UNDERBASE_IS_HEAD_1` is wrong as stated. The correct reading is that head 1
is the first head in the rotation, which is the base *when there is one*. Head 10
is consistently the last colour down across every file in this batch — that one
does look like a convention.

## 7.5 Non-separation colour on the underbase plate

Four files carry ICCBased fills, and they sit on the **underbase artboard**:

```
#9945  F     iccbased × 21        #11758 F     iccbased × 21
#9945  B     iccbased × 30        #11758 B     iccbased × 30
```

Same defect class as #22829's planted orange, but on the plate where it matters
most. A non-separation fill on a base plate has no colorant to map to a screen.
Needs Tyler's read on whether this was acceptable practice at the time or was
always a mistake that printed anyway.

## 7.6 `#11302 B` — the 21825 defect, in the wild

```
ART ON 'Reg Marks & Info'   |   LIVE TEXT × 3
```

Same fault class as the planted one in #21825, found in a real historical file
that presumably printed fine. Worth stating plainly: **re-running Pre-Press Pro
on this file destroys the artwork**, because the script removes and rebuilds that
layer by name before it does anything else. That is not a hypothetical — it is
the single most destructive interaction in the whole toolchain, and PrintScope
should flag it red on any file, any era.

## 7.7 Naming drift — the case for `CONVENTION_DRIFT` monitoring

Every ink name in the batch, verbatim:

```
1-110 Under              ← space instead of hyphen, and a trailing space
1-110-Grey 429 C
1-110-Under
1-160-Grey 429 C
1-160-Under
10-160-Brown7568         ← no space before the number
10-160-Maroon 188 C
10-160-WHite             ← typo
10-160-White
10-200-Maroon 188 C
5-160-Grey 429 C
5-200-Red 186            ← no ' C' suffix
6-160-Green3435          ← trailing space
6-200-Blk                ← abbreviation
6-230-Green3435
7-160-Brown7568
9-200-Tan7401
```

The `NAME` regex accepted all 17, because it only requires
`^\d+(-\d+)?( & \d+-\d+)?-.+$` — and `1-110 Under` slips through on the `.+`.
That is the regex being *correctly* permissive about ink names and
*incorrectly* silent about the mesh delimiter. Tighten the structural part,
keep the ink part loose:

```
^\d+(-\d+)?( & \d+-\d+)?-\S.*$      and separately assert the mesh delimiter
```

Every one of `Blk`, `WHite`, `Green3435`, `Red 186` and the trailing spaces
would break an exact-match screen forecast. `160mesh-24` tallies are only as
good as the string parsing beneath them.

## 7.8 Filename variants

```
#11443 RS BN        #11556 RS BN        ← 'RS BN' — location plus a qualifier
#11556 Left Leg     ← canonical is LLEG
#13440 Frioni Coougars     ← team name in the location slot, with a typo
```

This is the third independent piece of evidence for the canonical-naming
question raised in the feasibility report. A human reads through all of it. A
generator writing filenames cannot, and a Printavo lookup keyed on the location
code will miss all four.

## 7.9 The reorder signal — possibly the most valuable thing here

Three invoices produced byte-comparable artwork:

```
#11443 F, #11556 F, #13843 F  →  identical ink set, art bbox identical to 0.001pt
```

That is a **repeat order that was re-separated from scratch each time**, and paid
for each time. An art fingerprint — ink set plus normalised geometry hash — would
have caught it at intake.

This connects directly to the reorder portal already in the Hub. Worth its own
line in the roadmap: *before sending a job to seps.io, check whether these plates
already exist.* It needs no generator, no trap logic and no new judgment — just a
hash and a lookup — and on this evidence it pays for itself.

---

# Addendum 8 — the #22541–#22600 batch (15 files, plus a changed #22563)

*Fifteen new 2025–26 files, all recent, none planted. Each arrived twice — as
`X OUTPUT.ai` and `X OUTPUT 2.ai`. All fifteen pairs are byte-identical
(md5 verified on the device), so only one of each was analysed.*

## 8.1 Eight of fifteen have the entire separation on `Reg Marks & Info`

This is the finding. It is not marginal and it is not a parser artifact.

```
#22560 B     93 paint ops   → Reg Marks & Info     PASTE ART HERE empty
#22560 LC    56                   "                        "
#22560 RS   118                   "                        "
#22590 B     40                   "                        "
#22590 LC    25                   "                        "
#22596 B    154                   "                        "
#22596 LC    21                   "                        "
#22600 F    231                   "                        "
```

Verified twice through independent code paths: once through the full recursive
walker, once through a thirty-line loop that does nothing but count paint
operators between `BDC /OC` and `EMC` at page level. Same answer both times. The
control files come back the other way — `#22599 B` reads `PASTE ART HERE: 407,
Reg Marks & Info: 1` — so the detector is discriminating, not saturating.

**Pre-Press Pro removes and rebuilds `Reg Marks & Info` by name before it does
anything else.** Re-running it on any of these eight destroys the entire
separation, not a stray object. Addendum 7 found one historical file in the same
state and #21825 had it planted deliberately; this batch says it is not rare, it
is roughly half of recent output.

`ART_ON_REG_MARKS_LAYER` should be the highest-priority red rule in the table.
It is one dictionary lookup, it has zero false-positive surface, and the failure
it prevents is total.

### `Koozie Guides` predicts it

```
Koozie Guides present   7 files   7 correct    0 wrong
Koozie Guides absent    9 files   1 correct    8 wrong
```

Illustrator version does not explain the split — 30.4 and 30.7 both appear on
both sides. The `Koozie Guides` layer does, near perfectly. It appears to mark
files built from one template, and files from that template land the art on the
right layer. Worth knowing where that template lives and whether the other
workflow can be pointed at it, because that is a fix at the source rather than a
rule that catches the damage afterwards.

## 8.2 Trap coverage is inconsistent across recent files

```
trapped
  #22541 B REVISED   0.75pt choke × 52   (zero-ink K stroke on the base)
  #22599 B           0.75pt choke × 294
  #22596 B           0.75pt choke × 82
  #22596 LC          0.75pt choke × 7
  #22586 F           0.75pt choke × 5
  #22541 LC          0.75pt spread × 16 on Tan 4685 C      + one 1.25pt stroke
  #22560 LC          0.25pt spread × 16  +  0.25pt choke × 16

untrapped — underbase present, no stroke on any plate
  #22583 B    #22583 F    #22563 F    #22560 B    #22560 RS
```

Two things to flag rather than judge:

**#22541 LC carries a 1.25pt stroke** on `10-200-Green574`, one instance, alongside
sixteen correct 0.75pt spreads. 1.25 does not fit the 0.75 invariant under any
split. Single-object outlier — could be intentional, could be a stray.

**#22560 LC sums to 0.50, not 0.75.** 0.25 spread on `6-230-Green 356 C` plus a
0.25 zero-ink choke on the `9-230-Light Green 368 C` plate. Every other split
trap in the corpus sums to 0.75.

Five files with a base and no trap at all is the larger question. Addendum 7
found the same thing across the 2021–23 archive. Two batches now say untrapped
separations are ordinary output, which means `UNDERBASE_CHOKE_PER_OBJECT` cannot
be a red fail as written — it would fire on a third of the corpus.

## 8.3 A combined-plate ink name the regex rejects

```
#22591 F   single separation:   1-160&10-160-White&Navy 289
```

One plate carrying two heads and two inks. The convention established earlier
used spaces — `1-160 & 10-160-...` — and the `NAME` regex requires
`( & \d+-\d+)?` with them. This file has no spaces, so it fails the rule. The
name is legitimate; the regex is wrong. Both spellings need accepting, and the
head/ink pairing needs parsing out of both for the screen forecast.

## 8.4 Multi-plate files break the register check as designed

`#22541 B REVISED` has four artboards — a five-ink colour composite, the
underbase, a white plate and a black plate. Comparing artboard bboxes pairwise
reports ab3 and ab4 as out of register by 123pt and 40pt. They are not. Their art
simply does not cover the same extent as the composite, so a union bbox is not a
comparable quantity.

> The register check is only valid between the **underbase and the union of the
> colour plates**. Applied artboard-to-artboard on a per-ink file it produces
> garbage.

Restricted correctly, ab2 against ab1 is 0.000pt. Every other multi-artboard file
in the batch is 0.000pt as well. The 1pt nudge planted in #21825 remains the only
true positive this detector has ever produced, and this batch nearly turned it
into a false-positive generator.

## 8.5 `#22563 F` changed on disk

The copy now in the folder is 460,302 bytes; the one analysed earlier was
460,449, same mtime. Its contents differ — it now reads `10-230-White`,
`5-230-Blue 286 C`, `6-230-Gray 432` with **no strokes on any plate**, where the
earlier copy had the grey stroke around the navy that was discussed. Re-staged
and re-analysed; the results above are from the current file.

Worth noting as a process point: PrintScope needs to record which byte-version of
a file it inspected, or a passing verdict can outlive the file it applied to.

## 8.6 Nothing was planted in either batch

Tyler confirmed no defects were planted in the historical fifteen, and none in
these. Everything above is ordinary production output. That makes the
`Reg Marks & Info` finding more serious, not less — eight live files in one
sample are one Pre-Press Pro run away from being destroyed.

---

# Addendum 9 — three corrections, and the trap rule finally gets a metric

*Tyler's read on Addendum 8. All three of my flags were wrong in the same way as
the previous three, and one of the corrections turns out to be measurable.*

## 9.1 Layer placement is not a defect

> *"The layers on which the artwork and plate names are on don't necessarily
> really indicate a good or bad file. It's just where someone pastes the art in,
> so I wouldn't worry too much about that as long as there is art, file name &
> swatch names."*

`ART_ON_REG_MARKS_LAYER` is withdrawn before it was ever written. A finished
output file is judged on having artwork, a filename and swatch names. Which
Illustrator layer holds the art is an artifact of where the cursor was.

`ART_LAYER_NOT_EMPTY` is replaced by **`ART_PRESENT`**, scoped to any layer.
`EXPECTED_LAYERS_PRESENT` drops from flag to **info**.

The Pre-Press Pro hazard is real but belongs somewhere else: the script removes
`Reg Marks & Info` by name, so *anything that re-runs it* on a file whose art
lives there destroys the art. That is a constraint on the future generator and on
any batch re-processing, not a verdict on a file that has already been output.
Moved to the generator feasibility notes; removed from the inspection rules.

This also means the `Koozie Guides` correlation in §8.1 was a correlation with
nothing. Tyler is checking what that layer is for separately.

## 9.2 Absent trap is usually correct — and now measurable

> *"When a color is surrounded by a White or a color that is knocked out of the
> underbase, it fits snugly within the bounding ink so it does not require a
> stroke/choke to ensure it covers the underbase. Sometimes we will add a minimal
> choke just for good measure and out of habit."*

This is the same principle as the 21797 refinement — trap is needed where a
shape meets **negative space**, not where it meets another ink — and it explains
every untrapped file in both recent batches.

It is also testable. Rendering each separation at 200 dpi, taking each
colorant's perimeter, and measuring what fraction of it lies adjacent to any
other ink:

```
UNTRAPPED FILES                              perimeter abutting other ink
  22583 B   Purple 268 C                              93.4%
  22583 F   Purple 268 C                              90.8%
  22563 F   Blue 286 C                                76.2%
  22563 F   Gray 432                                  84.9%
  22560 B   Green 356 C                               90.9%
  22560 RS  Blue 282 C                                89.7%
  22560 RS  Red 193 C                                 91.6%

TRAPPED FILES (control)
  22586 F   Royal 286 C                                0.0%
  22599 B   Blue 542 C                                 4.5%
  22596 B   Black                                     10.0%
  22596 B   Red 7621 C                                27.3%
  22599 B   Red 172 C                                 29.4%
  22596 B   Orange 1645 C                             56.0%
```

**Thirteen measurements, no overlap.** Everything untrapped is ≥ 76%; everything
trapped is ≤ 56%. The gap is twenty points wide.

White behaves differently and is excluded — it is the bounding ink, its outer
perimeter *is* the design edge, and an underbase beneath white needs no choke
anyway. In the untrapped files white reads 25–41%, exactly as expected for the
ink that does the bounding.

### The rule, three-state

```
perimeter abutting other ink   > 85%          no trap needed          GREEN
                                70–85%        trap optional (habit)   YELLOW
                                < 70% + no trap                       RED
```

This is what Tyler's "sometimes we add a minimal choke out of habit" looks like
as a rule — the middle band is real judgment, and it gets the yellow it deserves
rather than a red it doesn't.

`UNDERBASE_CHOKE_PER_OBJECT` drops from **fail to info**. It no longer demands a
trap; it reports whether the trapping that *is* present sums to 0.75. The
requirement moves entirely to `TRAP_AT_NEGATIVE_SPACE`, which now carries the
measured threshold above.

That resolves the §8.2 problem. The old rule fired on a third of the corpus. The
new one fires on none of it.

## 9.3 #22541 B REVISED is opacity work, not a structural anomaly

> *"This is another special handling similar to the gradients... in addition to
> gradient transitions, there are opacity variations used. Any opacity less than
> 100% is converted to halftones during the RIP process when outputting the
> plate."*

Measured across 24 files, and it is a clean singleton:

```
22541 B REVISED    ca/CA values 0.2, 0.25, 0.37, 0.4, 0.45, 0.5   + 1 soft mask
all 23 others      none
blend modes        none anywhere in the corpus
```

So alpha alone is the signal — no blend-mode handling needed. New rule
**`OPACITY_VARIATION_PRESENT`**, yellow: *this file halftones at RIP, confirm
layering with the press operator, do not auto-release.*

Note that this is a **second, independent** special-handling marker. 22617's
gradient work shows up as `sh` shading operators and carries no opacity; 22541's
opacity work carries no shading. A generator's tier classifier needs both:

```
tier 3 if   shading operators present   OR   any ca/CA < 1   OR   soft mask present
```

Both are single-pass resource scans. Cheap, and between them they caught both
special-handling files in the corpus without a false positive on the other 22.

## 9.4 The false-positive ledger, updated

| Round | Called wrong | Actually |
|---|---|---|
| 21825 | trap at the wrong width | split trap, sums to 0.75 |
| 22699 | one head two inks — impossible | ink change mid-run |
| 22617 | artboard with one object | gradient blend technique |
| 22560 etc. | art on the wrong layer | wherever the artist pasted it |
| 22583 etc. | underbase with no trap | colour bounded by another ink |
| 22541 | four artboards, out of register | opacity work, halftones at RIP |

Six for six, all the same failure: **a rule that encoded one way of doing
something as the only way.** The pattern is now reliable enough to use as a
design test. Before any rule ships red, it has to answer one question — *does
this check an outcome, or a recipe?* Anything checking a recipe goes yellow or
info.

Current table: **37 rules — 17 fail, 14 flag, 6 info.**
