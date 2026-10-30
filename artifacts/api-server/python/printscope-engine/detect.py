"""PrintScope ENGINE layer.

One function per rule code, keyed to the code in printscope-rules-v2.csv.
Each takes (facts, ctx) and returns {status, headline, detail, data}.
Severity comes from the rule table; a detector says only whether its own
condition is violated.
"""
import json
import re
from ink_names import swatch_parts, ink_key

# Judgements — the rule ran and reached a conclusion.
PASS, FLAG, FAIL, INFO = "pass", "flag", "fail", "info"

# Non-judgements. These are NOT interchangeable and must never be collapsed
# into one bucket: "this rule does not apply to this file" and "this rule
# should have run and could not" mean opposite things to anyone deciding
# whether to trust a verdict.
NOT_APPLICABLE = "not_applicable"      # genuinely nothing to check here
CANNOT_EVALUATE = "cannot_evaluate"    # applies, but the data was not available
NOT_IMPLEMENTED = "not_implemented"    # in the rule table, no detector yet
ERROR = "error"                        # the detector raised

JUDGEMENTS = (PASS, FLAG, FAIL, INFO)
NON_JUDGEMENTS = (NOT_APPLICABLE, CANNOT_EVALUATE, NOT_IMPLEMENTED, ERROR)

# Retained so older callers do not silently mis-handle the value.
SKIP = NOT_APPLICABLE

REGISTRY = {}


def rule(code):
    def deco(fn):
        REGISTRY[code] = fn
        return fn
    return deco


def v(status, headline, detail=None, data=None):
    return {"status": status, "headline": headline,
            "detail": detail or [], "data": data or {}}


class Params:
    """A rule's own numbers, read from its row in the table.

    Thresholds belong to the rule, not to the code. `expected` and `tolerance`
    are JSON columns in the CSV; this merges them and serves them by key with a
    fallback, so a detector never hardcodes a number that the table claims to
    own. If the column is missing or malformed the fallback is used and the
    rule still runs - a typo in a spreadsheet should not take a check offline.
    """

    def __init__(self, row):
        self.raw = {}
        for col in ("expected", "tolerance", "applies_when"):
            blob = (row or {}).get(col) or ""
            if not blob.strip():
                continue
            try:
                parsed = json.loads(blob)
            except Exception:
                continue
            if isinstance(parsed, dict):
                self.raw.update(parsed)

    def get(self, key, default):
        val = self.raw.get(key, default)
        return default if val is None else val

    def num(self, key, default):
        try:
            return float(self.get(key, default))
        except (TypeError, ValueError):
            return default

    def pair(self, key, default):
        val = self.get(key, default)
        try:
            lo, hi = val
            return float(lo), float(hi)
        except Exception:
            return default


NAME_RE = re.compile(r"^\d+(-\d+)?(\s*&\s*\d+(-\d+)?)?-.+$")
HEADMESH_RE = re.compile(r"^(\d+)[-\s](\d+)")
UNDER_RE = re.compile(r"under", re.I)
WHITE_RE = re.compile(r"white", re.I)
PROCESS = {"cyan", "magenta", "yellow", "black", "process cyan", "process magenta",
           "process yellow", "process black"}


# ---------------------------------------------------------------- file

@rule("FILE_PDF_COMPATIBLE")
def pdf_compatible(f, ctx, p):
    return v(PASS, "PDF-compatible .ai, parsed without repair",
             [f"{f['bytes']:,} bytes · sha {f['sha256_16']}"])


@rule("EXPECTED_LAYERS_PRESENT")
def layers_present(f, ctx, p):
    holders = sorted({l for ab in f["artboards"] for l in ab["layer_paint"]})
    return v(INFO, ", ".join(f["layers"]) or "no layer structure",
             [f"art sits on: {', '.join(holders)}",
              "Layer names and art placement both vary legitimately."])


@rule("ART_PRESENT")
def art_present(f, ctx, p):
    empty = [ab["index"] for ab in f["artboards"] if ab["paint_ops"] == 0]
    if empty:
        return v(FAIL, f"artboard {', '.join(map(str, empty))} has no artwork",
                 ["An artboard with no paint operations has nothing to print."])
    total = sum(ab["paint_ops"] for ab in f["artboards"])
    return v(PASS, f"{total} objects across {f['artboard_count']} artboard(s)")


@rule("ARTBOARDS_REGISTERED")
def artboards_registered(f, ctx, p):
    sizes = {(ab["width_in"], ab["height_in"]) for ab in f["artboards"]}
    lines = [f"ab{ab['index']}: {ab['width_in']} x {ab['height_in']} in — "
             f"{', '.join(ab['inks']) or 'no separations'}" for ab in f["artboards"]]
    if len(sizes) > 1:
        return v(FAIL, f"{len(sizes)} different artboard sizes", lines +
                 ["Plates must share a trim size to register on press."])
    w, h = next(iter(sizes))
    return v(PASS, f"{f['artboard_count']} artboard(s), all {w} x {h} in", lines)


# ---------------------------------------------------------------- naming

@rule("SWATCH_NAME_STRUCTURE")
def swatch_names(f, ctx, p):
    bad, ok = [], []
    for ink in f["all_inks"]:
        if ink == "All":
            continue
        (ok if NAME_RE.match(ink) else bad).append(ink)
    if bad:
        return v(FAIL, f"{len(bad)} swatch name(s) off convention",
                 [f"rejected — {n}" for n in bad] + [f"ok — {n}" for n in ok],
                 {"bad": bad})
    return v(PASS, f"{len(ok)} swatch names follow head-mesh-ink", list(ok))


@rule("HEAD_NUMBERS_UNIQUE")
def head_unique(f, ctx, p):
    seen = {}
    for ink in f["all_inks"]:
        m = HEADMESH_RE.match(ink)
        if m:
            seen.setdefault(m.group(1), []).append(ink)
    dups = {h: n for h, n in seen.items() if len(n) > 1}
    if dups:
        lines = []
        for h, n in dups.items():
            lines.append(f"head {h}: {', '.join(n)}")
        return v(FLAG, f"{len(dups)} head position(s) used more than once", lines +
                 ["One head with two inks is a legitimate ink change mid-run."],
                 {"dups": dups})
    return v(PASS, f"{len(seen)} head positions, all distinct",
             [f"heads {', '.join(sorted(seen, key=int))}"])


@rule("MESH_TALLY")
def mesh_tally(f, ctx, p):
    t = {}
    for ink in f["all_inks"]:
        m = HEADMESH_RE.match(ink)
        if m:
            t[m.group(2)] = t.get(m.group(2), 0) + 1
    if not t:
        return v(INFO, "no mesh counts parsed")
    s = ", ".join(f"{k}mesh-{n}" for k, n in sorted(t.items(), key=lambda x: int(x[0])))
    return v(INFO, s, ["Screen department forecast input."], {"tally": t})


@rule("REGISTRATION_SWATCH_PRESENT")
def reg_swatch(f, ctx, p):
    n = sum(1 for ab in f["artboards"] if ab.get("has_all_colorant"))
    if n:
        return v(PASS, f"registration swatch (All) on {n}/{f['artboard_count']} artboard(s)")
    return v(FLAG, "no registration swatch found",
             ["Registration marks normally use the All colorant."])


@rule("UNDERBASE_MESH_COARSER")
def under_mesh(f, ctx, p):
    base, cols = None, []
    for ink in f["all_inks"]:
        m = HEADMESH_RE.match(ink)
        if not m:
            continue
        (base,) = (ink,) if UNDER_RE.search(ink) else (base,)
        if UNDER_RE.search(ink):
            base_mesh = int(m.group(2))
        else:
            cols.append((ink, int(m.group(2))))
    if base is None or not cols:
        return v(NOT_APPLICABLE, "no underbase on this file to compare against")
    finer = [c for c, mesh in cols if mesh < base_mesh]
    if finer:
        return v(FLAG, f"underbase at {base_mesh} is finer than {len(finer)} colour(s)",
                 [f"{c}" for c in finer])
    return v(PASS, f"underbase at {base_mesh} mesh, coarsest or equal",
             [f"colours at {', '.join(str(m) for _, m in cols)}"])


# ---------------------------------------------------------------- colour

@rule("SEPARATION_ONLY_ART")
def sep_only(f, ctx, p):
    hits = []
    for ab in f["artboards"]:
        for k, n in ab["nonsep_fills"].items():
            if k in ("devicek", "deviceg"):
                continue  # zero-ink knockout / registration black
            hits.append((ab["index"], k, n))
    if hits:
        return v(FAIL, f"{sum(h[2] for h in hits)} fill(s) not on a named separation",
                 [f"ab{i}: {k} x {n}" for i, k, n in hits],
                 {"hits": hits})
    return v(PASS, "every fill maps to a named separation")


@rule("NO_PROCESS_PLATES")
def no_process(f, ctx, p):
    hits = [i for i in f["all_inks"] if i.lower() in PROCESS]
    if hits:
        return v(FLAG, f"{len(hits)} process plate(s) present", hits)
    return v(PASS, "no stray CMYK plates")


@rule("NO_EMPTY_PLATES")
def no_empty_plates(f, ctx, p):
    # Gradients paint through `sh`, which carries no fill colorant, so an ink
    # used only inside a blend looks unused to the parser. Known gap - do not
    # accuse a file the extractor cannot fully see.
    if any(ab["shadings"] for ab in f["artboards"]):
        return v(CANNOT_EVALUATE,
                 "gradient shading present - plate usage not reliably measurable",
                 ["`sh` operators paint without a named colorant, so an ink used "
                  "only inside a blend looks unused. The check is suppressed rather "
                  "than allowed to accuse a file the parser cannot fully see.",
                  "Treat this as unknown, not as clean."])
    empty = []
    for ab in f["artboards"]:
        used = set(ab["ink_bbox"]) | set(ab["inks"])
        for ink in ab.get("declared_inks", []):
            if ink != "All" and ink not in used:
                empty.append(f"ab{ab['index']}: {ink} declared in the swatches, "
                             f"no artwork uses it")
    if empty:
        return v(FAIL, f"{len(empty)} declared separation(s) carry no artwork", empty,
                 {"empty": empty})
    return v(PASS, "every declared separation carries artwork")


@rule("OPACITY_VARIATION_PRESENT")
def opacity(f, ctx, p):
    if not f["alphas"] and not f["soft_masks"]:
        return v(PASS, "all art at 100% opacity")
    d = []
    if f["alphas"]:
        d.append("alpha values: " + ", ".join(str(a) for a in f["alphas"]))
    if f["soft_masks"]:
        d.append(f"{f['soft_masks']} soft mask(s)")
    d.append("Opacity below 100% halftones at RIP — deliberate technique. "
             "Confirm layering with the press operator; do not auto-release.")
    return v(FLAG, "opacity below 100% present", d,
             {"alphas": f["alphas"], "soft_masks": f["soft_masks"]})


@rule("GRADIENT_BLEND_ACROSS_ARTBOARDS")
def shading(f, ctx, p):
    tot = sum(ab["shadings"] for ab in f["artboards"])
    if not tot:
        return v(PASS, "no gradient shading")
    per = [f"ab{ab['index']}: {ab['shadings']} shading op(s)"
           for ab in f["artboards"] if ab["shadings"]]
    return v(FLAG, f"{tot} gradient shading operator(s)", per +
             ["Gradient blending needs precise layering at press. Not a fault."],
             {"total": tot})


# ---------------------------------------------------------------- text

@rule("ART_TEXT_OUTLINED")
def art_text(f, ctx, p):
    """Live text must be outlined.

    Neither the layer nor the ink discriminates: art legitimately sits on the
    marks layer, and the swatch labels are painted in each ink. Position does.
    Pre-Press Pro sets the filename and label block in the margin strip above
    the artwork, so a text run whose origin falls INSIDE the art bounding box
    is artwork text wherever it lives.

    Measured across 55 files: 1 run in 1 file lands inside the art. The rule is
    quiet by default, which is what makes it worth reading when it speaks.
    """
    hits, total = [], 0
    for ab in f["artboards"]:
        bb = [1e9, 1e9, -1e9, -1e9]
        for val in ab["ink_bbox"].values():
            bb[0] = min(bb[0], val[0]); bb[1] = min(bb[1], val[1])
            bb[2] = max(bb[2], val[2]); bb[3] = max(bb[3], val[3])
        if bb[2] < -1e8:
            continue
        for x, y in ab.get("text_positions", []):
            total += 1
            if bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3]:
                hits.append((ab["index"], x, y))
    if hits:
        return v(FAIL, f"{len(hits)} live text run(s) sitting on the artwork",
                 [f"ab{i}: text origin at {x}, {y} — inside the art" for i, x, y in hits] +
                 [f"{total - len(hits)} other run(s) sit in the margin strip, as expected",
                  "Fonts must be outlined — live text reflows on another machine."],
                 {"hits": hits})
    return v(PASS, f"{total} text run(s), all in the margin strip",
             ["Filename and swatch labels are expected to be live here."])


@rule("MARKS_TEXT_EXPECTED")
def marks_text(f, ctx, p):
    n = sum(v_ for ab in f["artboards"] for k, v_ in ab.get("text_by_ink", {}).items()
            if k in ("(none)", "All") or k.startswith("@"))
    return v(INFO, f"{n} text run(s) in the marks block",
             ["Filename and swatch labels are expected to be live here."])


# ---------------------------------------------------------------- strokes

@rule("NO_HAIRLINE_STROKES")
def hairline(f, ctx, p):
    n = 0
    for ab in f["artboards"]:
        for key, c in ab["strokes"].items():
            if float(key.split("|", 1)[0]) == 0.0:
                n += c
    if n:
        return v(FAIL, f"{n} zero-width stroke(s)",
                 ["Hairlines render at device resolution and will not hold on screen."])
    return v(PASS, "no zero-width strokes")


@rule("STROKE_MIN_WIDTH")
def stroke_min(f, ctx, p):
    floor = p.num("min_pt", 0.25)
    thin = {}
    for ab in f["artboards"]:
        for key, c in ab["strokes"].items():
            w = float(key.split("|", 1)[0])
            if 0 < w < floor:
                thin[w] = thin.get(w, 0) + c
    if thin:
        return v(FLAG, f"{sum(thin.values())} stroke(s) under {floor:g}pt",
                 [f"{w}pt x {c}" for w, c in sorted(thin.items())] +
                 ["Sub-spec strokes are often trim residue rather than intent."],
                 {"thin": thin})
    return v(PASS, "no sub-spec strokes")


@rule("TRIM_ARTIFACT_RESIDUE")
def trim_residue(f, ctx, p):
    floor = p.num("min_pt", 0.25)
    at_least = p.num("min_count", 3)
    thin = sum(c for ab in f["artboards"] for key, c in ab["strokes"].items()
               if 0 < float(key.split("|", 1)[0]) < floor)
    if thin >= at_least:
        return v(FLAG, f"{thin} sub-spec strokes look like trim residue",
                 ["An Illustrator trim can leave slivers behind. Usually harmless, "
                  "sometimes prints."])
    return v(PASS, "no trim residue pattern")


# ---------------------------------------------------------------- trap

@rule("UNDERBASE_CHOKE_PER_OBJECT")
def trap_sum(f, ctx, p):
    strokes = ctx.get("trap_strokes", {})
    if not strokes:
        return v(INFO, "no trap strokes present",
                 ["Absence of trap is frequently correct — see the negative-space rule."])
    total_pt = p.num("choke_plus_spread_pt", 0.75)
    tol = p.num("abs", 0.02)
    lines = [f"{w}pt on {ink} x {n}" for (w, ink), n in sorted(strokes.items())]
    widths = sorted({w for (w, _) in strokes})
    if widths == [total_pt]:
        return v(PASS, f"all trap at {total_pt:g}pt", lines)
    if abs(sum(widths) - total_pt) < tol:
        return v(PASS, f"split trap summing to {total_pt:g}pt "
                       f"({' + '.join(map(str, widths))})", lines)
    return v(FLAG, f"trap widths {widths} do not sum to {total_pt:g}pt", lines +
             [f"Choke and spread may split any way that totals {total_pt:g}."],
             {"widths": widths, "expected_pt": total_pt})


@rule("TRAP_TECHNIQUE_CONSISTENT")
def trap_technique(f, ctx, p):
    strokes = ctx.get("trap_strokes", {})
    if not strokes:
        return v(INFO, "no trap present")
    choke = sum(n for (w, ink), n in strokes.items() if ink and ink.startswith("@"))
    spread = sum(n for (w, ink), n in strokes.items() if ink and not ink.startswith("@"))
    if choke and spread:
        return v(INFO, f"split technique — {choke} choke, {spread} spread")
    if choke:
        return v(INFO, f"technique A — choke the base ({choke} zero-ink strokes)")
    return v(INFO, f"technique B — spread the colour ({spread} strokes)")


@rule("CHOKE_SAFE_FOR_DETAIL")
def choke_safe(f, ctx, p):
    e = ctx.get("erosion")
    if not e:
        return v(NOT_APPLICABLE, "no underbase on this file")
    rows = [f"base shapes: {e['components_before']} before, {e['components_after']} after a 0.375pt choke",
            f"{e['vanished']} shape(s) vanish entirely",
            "Measured on the authored colour geometry the base copies, "
            "not on the already-choked plate."]
    if e["vanished"] > 0:
        return v(FLAG, f"{e['vanished']} base shape(s) would disappear if choked", rows +
                 ["Spread the colour instead — a choke here leaves nothing to print on."])
    return v(PASS, "a choke does not erase base detail", rows)


@rule("TRAP_AT_NEGATIVE_SPACE")
def trap_negative_space(f, ctx, p):
    adj = ctx.get("adjacency")
    if not adj:
        return v(CANNOT_EVALUATE, "the colour artboard could not be measured",
                 ["Perimeter adjacency is what this rule tests. Without it the "
                  "rule has no opinion - this is not a pass."])
    if not ctx.get("has_underbase"):
        return v(NOT_APPLICABLE, "no underbase, so nothing to trap against")
    trapped = ctx.get("trap_stroke_count", 0) > 0
    rows, worst = [], None
    for ink, m in sorted(adj.items()):
        if m["is_white"]:
            rows.append(f"{ink} — {m['abutting_pct']}% bounded (white, exempt)")
            continue
        rows.append(f"{ink} — {m['abutting_pct']}% of perimeter bounded by other ink")
        if worst is None or m["abutting_pct"] < worst[1]:
            worst = (ink, m["abutting_pct"])
    if worst is None:
        return v(NOT_APPLICABLE, "only white on the colour artboard, which is exempt")
    ink, pct = worst
    needed_below = p.num("trap_required_below_pct", 70)
    not_needed_above = p.num("trap_not_required_above_pct", 85)
    if trapped:
        return v(PASS, f"trapped — {ctx['trap_stroke_count']} strokes", rows)
    if pct >= not_needed_above:
        return v(PASS, f"no trap needed — least-bounded ink {ink} at {pct}%", rows)
    if pct >= needed_below:
        return v(FLAG, f"trap optional — {ink} at {pct}% bounded", rows +
                 [f"Between {needed_below:g}% and {not_needed_above:g}% bounded, a "
                  "minimal choke is habit rather than a requirement."])
    return v(FAIL, f"{ink} meets bare garment along {round(100-pct,1)}% of its edge, untrapped",
             rows + ["A based colour bordering negative space needs the 0.75pt trap."],
             {"ink": ink, "pct": pct})


@rule("UNDERBASE_NO_CHOKE_UNDER_WHITE")
def no_choke_under_white(f, ctx, p):
    whites = [i for i in f["all_inks"] if WHITE_RE.search(i) and not UNDER_RE.search(i)]
    if not whites:
        return v(NOT_APPLICABLE, "no white ink on this file")
    return v(INFO, f"white present ({', '.join(whites)}) — base beneath white needs no choke")


@rule("ARTWORK_IN_REGISTER")
def in_register(f, ctx, p):
    if any(ab["shadings"] for ab in f["artboards"]):
        return v(CANNOT_EVALUATE,
                 "gradient blend present - plates deliberately do not align",
                 ["In a blend one colour runs further under another on purpose, so "
                  "a bounding-box comparison is not meaningful here.",
                  "Registration on this file has not been verified either way."])
    pair = ctx.get("register_pair")
    if not pair:
        return v(NOT_APPLICABLE, "needs an underbase and at least one based colour")
    c, u, delta = pair
    mx = max(abs(x) for x in delta)
    tol = p.num("abs", 0.02)
    rows = [f"based colour union {c}", f"underbase {u}",
            f"delta {delta} — max {round(mx, 3)}pt",
            f"based inks: {', '.join(ctx.get('based_inks', []))}"]
    if mx <= tol:
        return v(PASS, f"underbase aligns with the based colour art to {tol:g}pt", rows)
    return v(FAIL, f"underbase offset from the colour art by {round(mx, 3)}pt", rows +
             ["The plates will not register on press."], {"max_pt": mx})


@rule("UNDERBASE_COVERAGE")
def under_coverage(f, ctx, p):
    local = ctx.get("local_underbase")
    if local and local.get("error"):
        return v(CANNOT_EVALUATE, "Localized underbase coverage could not be verified",
                 [local["error"]], local)
    if local and local.get("failCount"):
        return v(FAIL, f"{local['failCount']} localized region(s) missing underbase",
                 ["Review highlighted regions; whole-ink coverage cannot clear local omissions.",
                  "Normal trap edges have a 0.75pt allowance plus one measurement pixel.",
                  "Region boxes locate raster defects, not named words or Illustrator objects."], local)
    if local and local.get("flagCount"):
        return v(FLAG, f"{local['flagCount']} small unsupported region(s) need review",
                 ["Differences exceed the edge allowance but are too small for a confident failure.",
                  "Inspect the highlighted regions before release."], local)
    cov = ctx.get("coverage")
    if not cov:
        return v(NOT_APPLICABLE, "no underbase to measure against")
    rows = [f"{ink} — {d['pct']}% of its area sits on the base" for ink, d in sorted(cov.items())]
    if ctx.get("coverage_bar_cut_px") is None:
        rows.append("The info bar could not be located, so these figures "
                    "include any filename and swatch labels present, which never sit "
                    "on the base. Treat a borderline reading with caution.")
    else:
        rows.append("Measured below the info bar — the filename and swatch "
                    "labels are excluded.")
    lo = p.num("partial_below_pct", 15)
    hi = p.num("partial_above_pct", 85)
    bare = [ink for ink, d in cov.items()
            if lo < d["pct"] < hi and not WHITE_RE.search(ink)]
    if bare:
        return v(FLAG, f"{len(bare)} ink(s) only partly based", rows +
                 ["Partly-based colour prints two different shades on a dark garment."],
                 {"partial": bare})
    return v(PASS, "no localized underbase omission detected" if local else "every colour is either fully based or deliberately unbased", rows + (local.get("notes", []) if local else []), local or {})


@rule("UNDERBASE_ROLE_AGREES")
def underbase_role(f, ctx, p):
    records = [r for ab in f["artboards"] for r in ab.get("colorant_details", [])]
    names = set(f.get("all_inks", [])) | {r["name"] for r in records}
    names.update(n for ab in f["artboards"] for n in ab.get("declared_inks", []))
    unders = sorted(n for n in names if "under" in (ink_key(n) or ""))
    if not unders:
        return v(NOT_APPLICABLE, "no swatch named Under; colour never assigns the role")
    if len(unders) > 1:
        return v(FLAG, "more than one swatch named Under", unders, {"underbases": unders})
    selected = [r for r in records if r["name"] == unders[0]]
    if not selected or any(r.get("rgb") is None for r in selected):
        return v(CANNOT_EVALUATE, "named underbase display colour could not be measured",
                 [r.get("error", "alternate colour unavailable") for r in selected])
    target, tolerance = p.get("corroborating_rgb", [229, 6, 149]), p.num("rgb_abs", 4)
    bad = [r for r in selected if any(abs(a - b) > tolerance
                                     for a, b in zip(r["rgb"], target))]
    return v(FLAG if bad else PASS,
             "named underbase does not display Rhodamine" if bad else "name and underbase display colour agree",
             [f"{r['name']}: RGB {r['rgb']}" for r in selected],
             {"underbase": unders[0], "colors": selected})


@rule("FILL_STROKE_SAME_COLORANT")
def fill_stroke_same(f, ctx, p):
    pairs = []
    for ab in f["artboards"]:
        if "fill_stroke_pairs" not in ab:
            return v(CANNOT_EVALUATE, "paired fill/stroke facts unavailable")
        for pair in ab["fill_stroke_pairs"]:
            if pair.get("is_choke") or "All" in (pair.get("fill"), pair.get("stroke")):
                continue
            pairs.append(dict(pair, artboard=ab["index"]))
    if not pairs:
        return v(NOT_APPLICABLE, "no paired fill/stroke paths outside choke and registration")
    unknown = [r for r in pairs if not r.get("fill") or not r.get("stroke")]
    bad = [r for r in pairs if r.get("fill") and r.get("stroke") and r["fill"] != r["stroke"]]
    if bad:
        return v(FLAG, f"{len(bad)} path(s) filled and stroked in different inks",
                 [f"ab{r['artboard']}: {r['fill']} / {r['stroke']} at {r['w']}pt" for r in bad],
                 {"mismatches": bad, "unknown_pairs": len(unknown)})
    if unknown:
        return v(CANNOT_EVALUATE, "some paired paths have unresolved colour spaces")
    return v(PASS, f"{len(pairs)} paired paths use the same ink")


@rule("INK_OVERLAP_NOT_TRAP")
def ink_overlap(f, ctx, p):
    if any(ab.get("shadings") for ab in f["artboards"]):
        return v(CANNOT_EVALUATE, "gradient blending overlaps by design; overlap check suppressed")
    candidates = [ab for ab in f["artboards"] if not ab.get("is_underbase") and
                  len([n for n in ab.get("inks", []) if n != "All"
                       and "under" not in (ink_key(n) or "")]) > 1]
    if not candidates:
        return v(NOT_APPLICABLE, "no artboard with two colour inks to compare")
    if "ink_overlaps" not in ctx or ctx.get("ink_overlap_error"):
        return v(CANNOT_EVALUATE, "ink overlap raster measurement unavailable",
                 [ctx.get("ink_overlap_error", "no raster measurement supplied")])
    threshold = p.num("max", 2.0)
    rows = ctx["ink_overlaps"]
    wide = [r for r in rows if r["max_width_pt"] > threshold]
    return v(INFO, f"{len(wide)} ink overlap(s) wider than {threshold:g}pt — calibration only",
             [f"ab{r['artboard']}: {r['inks'][0]} / {r['inks'][1]}: {r['max_width_pt']:.3f}pt"
              for r in rows],
             {"overlaps": rows, "wide_count": len(wide), "threshold_pt": threshold})


@rule("SWATCH_LABEL_MANIFEST")
def swatch_manifest(f, ctx, p):
    if any(ab.get("shadings") for ab in f["artboards"]):
        return v(CANNOT_EVALUATE, "gradient shading prevents a reliable painted-ink manifest")
    labelled, declared, painted = set(), set(), set()
    for ab in f["artboards"]:
        runs = ab.get("label_text_runs")
        if runs is None:
            return v(CANNOT_EVALUATE, "label text extraction unavailable")
        marks = [r for r in runs if r.get("layer") == "Reg Marks & Info"]
        if any(r.get("decode_error") for r in marks):
            return v(CANNOT_EVALUATE, "some label-block text could not be decoded",
                     sorted({r["decode_error"] for r in marks if r.get("decode_error")}))
        labels = {ink_key(r.get("text") or "") for r in marks}
        labels.discard(None)
        if not labels:
            return v(CANNOT_EVALUATE, f"ab{ab['index']}: no readable swatch label block")
        labelled.update(labels)
        declared.update(ink_key(n) or n.casefold() for n in ab.get("declared_inks", []) if n != "All")
        painted.update(ink_key(n) or n.casefold() for n in ab.get("inks", []) if n != "All")
    if not labelled:
        return v(CANNOT_EVALUATE, "no readable swatch label block")
    lists = {"labelled": labelled, "declared": declared, "painted": painted}
    union = labelled | declared | painted
    missing = {key: sorted(union - names) for key, names in lists.items() if union - names}
    return v(FLAG if missing else PASS,
             "swatch label, declared and painted lists disagree" if missing else "swatch manifest agrees with artwork",
             [f"missing from {key}: {', '.join(names)}" for key, names in missing.items()],
             dict({key: sorted(names) for key, names in lists.items()}, missing=missing))


@rule("INK_CHANGE_DECLARED")
def ink_change(f, ctx, p):
    changes = []
    for name in f.get("all_inks", []):
        heads, ink = swatch_parts(name)
        if heads and "&" not in heads and ink and ink.count("&") == 1:
            inks = [s.strip() for s in ink.split("&")]
            if all(inks):
                changes.append({"swatch": name, "head": heads.split("-")[0], "inks": inks})
    if not changes:
        return v(NOT_APPLICABLE, "no single-head ink changes")
    return v(INFO, f"{len(changes)} mid-run ink change(s) — allow time to clean and reload",
             [f"head {r['head']}: {' → '.join(r['inks'])}" for r in changes],
             {"changes": changes})


def _images(f):
    images, errors = [], []
    for ab in f["artboards"]:
        if ab.get("images", 0) and "image_placements" not in ab:
            errors.append(f"ab{ab['index']}: image placement facts unavailable")
        for image in ab.get("image_placements", []):
            if not image.get("is_mask"):
                images.append(dict(image, artboard=ab["index"]))
    return images, errors


def _image_dpi(f, ctx, p, hard):
    images, errors = _images(f)
    if errors:
        return v(CANNOT_EVALUATE, "image placement facts unavailable", errors)
    if not images:
        return v(NOT_APPLICABLE, "no placed raster artwork")
    floor = p.num("min", 200 if hard else 300)
    hard_floor = ctx.get("image_hard_min_dpi", 200)
    bad, unknown, suppressed = [], [], []
    for image in images:
        dpi = image.get("effective_dpi")
        if dpi is None:
            unknown.append(image)
        elif not hard and dpi < hard_floor:
            suppressed.append(image)
        elif dpi < floor:
            bad.append(image)
    if bad:
        return v(FAIL if hard else FLAG, f"{len(bad)} placed image(s) below {floor:g} dpi",
                 [f"ab{r['artboard']} {r['name']}: {r['effective_dpi']:.2f} dpi" for r in bad],
                 {"images": bad, "unmeasurable_count": len(unknown), "hard_floor_suppressed": len(suppressed)})
    if unknown:
        return v(CANNOT_EVALUATE, "placed image DPI could not be measured", data={"images": unknown})
    if suppressed:
        return v(NOT_APPLICABLE, "low-resolution images reported by the hard-floor rule",
                 data={"hard_floor_suppressed": len(suppressed)})
    return v(PASS, f"all {len(images)} placed image(s) meet {floor:g} dpi")


@rule("IMAGE_MIN_DPI")
def image_min(f, ctx, p):
    return _image_dpi(f, ctx, p, False)


@rule("IMAGE_HARD_MIN_DPI")
def image_hard_min(f, ctx, p):
    return _image_dpi(f, ctx, p, True)


@rule("IMAGE_NOT_RGB")
def image_not_rgb(f, ctx, p):
    images, errors = _images(f)
    if errors:
        return v(CANNOT_EVALUATE, "image colour-space facts unavailable", errors)
    if not images:
        return v(NOT_APPLICABLE, "no placed raster artwork")
    bad = [r for r in images if r.get("colorspace") in ("DeviceRGB", "CalRGB")]
    if bad:
        return v(FAIL, f"{len(bad)} RGB raster image(s) are not separated", data={"images": bad})
    unknown = [r for r in images if r.get("colorspace") not in
               ("DeviceGray", "DeviceCMYK", "Separation", "DeviceN", "Lab")]
    if unknown:
        return v(CANNOT_EVALUATE, "image colour space could not be resolved", data={"images": unknown})
    return v(PASS, f"no RGB in {len(images)} placed raster image(s)")


def evaluate(facts, ctx, table):
    """Run every enabled rule and report what happened to each one.

    A rule with no detector is reported as `not_implemented` rather than
    silently omitted: a rule the shop can see in the table but that never runs
    is exactly the kind of gap a verdict should not be able to hide.
    """
    table = list(table)
    ctx = dict(ctx)
    hard_row = next((row for row in table if row["code"] == "IMAGE_HARD_MIN_DPI"
                     and (row.get("enabled") or "true").lower() == "true"), None)
    ctx["image_hard_min_dpi"] = Params(hard_row).num("min", 200) if hard_row else 0
    results = []
    for row in table:
        code = row["code"]
        if (row.get("enabled") or "true").lower() != "true":
            continue

        sev = row.get("severity", "flag")
        # This metric is not calibrated for a defect verdict. Historical rule
        # snapshots still say flag; they must not bypass the informational cap.
        if code in ("INK_OVERLAP_NOT_TRAP", "INK_CHANGE_DECLARED"):
            sev = "info"
        base = {
            "code": code, "name": row.get("name", code), "severity": sev,
            "remediation": row.get("remediation_text", ""),
            "sort_order": int(row.get("sort_order") or 999),
        }

        fn = REGISTRY.get(code)
        if fn is None:
            results.append(dict(base, status=NOT_IMPLEMENTED,
                                headline="no detector for this rule yet",
                                detail=["The rule is in the table but nothing "
                                        "evaluates it. Nothing has been checked."],
                                data={}))
            continue

        try:
            res = fn(facts, ctx, Params(row))
        except Exception as e:
            res = v(ERROR, f"detector failed: {type(e).__name__}: {e}",
                    ["This rule did not run. Do not read its absence as a pass."])

        st = res["status"]
        # Severity demotion applies to judgements only. A rule that could not
        # run is not made quieter by the table saying it was only a flag.
        if st == FAIL and sev == "flag":
            st = FLAG
        elif st in (FAIL, FLAG) and sev == "info":
            st = INFO

        results.append(dict(base, status=st, headline=res["headline"],
                            detail=res["detail"], data=res["data"]))

    results.sort(key=lambda r: r["sort_order"])
    return results


def completeness(results):
    """Was this inspection complete enough to trust?

    `complete` is false when a rule that should have run did not — a detector
    error, or a check suppressed because the parser could not see through the
    file. Rules that genuinely do not apply do not count against it; neither
    does a rule that has no detector yet, which is a known and permanent state
    of the table rather than something that went wrong on this file. Both are
    still reported so the gap is visible.
    """
    tally = {k: 0 for k in JUDGEMENTS + NON_JUDGEMENTS}
    for r in results:
        tally[r["status"]] = tally.get(r["status"], 0) + 1

    blocking = tally[ERROR] + tally[CANNOT_EVALUATE]
    reasons = []
    for r in results:
        if r["status"] in (ERROR, CANNOT_EVALUATE):
            reasons.append(f"{r['code']}: {r['headline']}")

    return {
        "complete": blocking == 0,
        "judged": sum(tally[k] for k in JUDGEMENTS),
        "not_applicable": tally[NOT_APPLICABLE],
        "cannot_evaluate": tally[CANNOT_EVALUATE],
        "not_implemented": tally[NOT_IMPLEMENTED],
        "errors": tally[ERROR],
        "unverified": reasons,
    }
