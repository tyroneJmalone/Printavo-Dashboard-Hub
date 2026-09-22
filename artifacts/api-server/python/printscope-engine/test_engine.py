"""Golden tests: the verdicts this engine is known to produce, and why.

Every assertion here corresponds to a conclusion that was checked by hand
against a real file during Phase 0. They exist so that a port, a refactor or a
dependency bump can be shown to preserve behaviour rather than assumed to.

Run:  python3 test_engine.py [path/to/corpus]

The corpus is Mint's own separation files. Point PRINTSCOPE_CORPUS at the
folder holding them, or pass it as an argument. Without it the suite skips
rather than fails, and says so.
"""
import json, os, sys, glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as CFG
import extract as EX
import detect as DT
import run as RUN
import vector as VEC
import raster as RS

_args = [a for a in sys.argv[1:] if not a.startswith("-")]
CORPUS = (_args[0] if _args
          else os.environ.get("PRINTSCOPE_CORPUS",
                              "/mnt/user-data/uploads/PrintScope"))

PASSED, FAILED, SKIPPED = [], [], []


def find(stem):
    """Files arrive with a '#' or '-' invoice prefix depending on the era."""
    for pat in (f"{stem}.ai", f"{stem} OUTPUT.ai", f"{stem} OUTPUT*.ai"):
        for pre in ("#", "-", ""):
            hits = sorted(glob.glob(os.path.join(CORPUS, pre + pat)))
            if hits:
                return hits[0]
    return None


def check(name, fn):
    path_missing = []

    def need(stem):
        p = find(stem)
        if not p:
            path_missing.append(stem)
        return p

    try:
        result = fn(need)
    except Exception as e:
        if path_missing:
            SKIPPED.append((name, "missing: " + ", ".join(path_missing)))
            return
        FAILED.append((name, f"{type(e).__name__}: {e}"))
        return
    if path_missing:
        SKIPPED.append((name, "missing: " + ", ".join(path_missing)))
    elif result is True:
        PASSED.append(name)
    else:
        FAILED.append((name, str(result)))


def inspect(path):
    table = RUN.load_table()
    facts = EX.extract(path)
    ctx = RUN.build_ctx(path, facts)
    return facts, ctx, DT.evaluate(facts, ctx, table)


def patched_table(code, **cols):
    """The rule table with one row's columns overridden, for proving that a
    threshold really is read from the table and not from the code."""
    table = RUN.load_table()
    for row in table:
        if row["code"] == code:
            row.update(cols)
    return table


def rule(results, code):
    for r in results:
        if r["code"] == code:
            return r
    return None


# --------------------------------------------------------------------- tests

def t_register_catches_the_planted_nudge(need):
    """#21825 had the underbase deliberately moved one click to the right."""
    p = need("22499 F") and need("21825 F1")
    if not p:
        return "skip"
    _, _, res = inspect(find("21825 F1"))
    r = rule(res, "ARTWORK_IN_REGISTER")
    if r["status"] != "fail":
        return f"expected fail, got {r['status']}: {r['headline']}"
    off = r["data"].get("max_pt", 0)
    if abs(off - 1.0) > 0.05:
        return f"expected a 1.0pt offset, measured {off}"
    return True


def t_register_passes_a_good_file(need):
    """Same check must stay quiet on a file known to be in register."""
    if not need("22499 F"):
        return "skip"
    _, _, res = inspect(find("22499 F"))
    r = rule(res, "ARTWORK_IN_REGISTER")
    return True if r["status"] == "pass" else f"got {r['status']}: {r['headline']}"


def t_declared_but_unused_plate(need):
    """#22554 calls out a Gold in the swatches that no artwork uses."""
    if not need("22554 F"):
        return "skip"
    _, _, res = inspect(find("22554 F"))
    r = rule(res, "NO_EMPTY_PLATES")
    if r["status"] != "fail":
        return f"expected fail, got {r['status']}"
    if not any("Gold" in e for e in r["data"].get("empty", [])):
        return f"expected the Gold plate, got {r['data']}"
    return True


def t_opacity_is_detected(need):
    """#22541 uses opacity below 100%, which halftones at RIP."""
    if not need("22541 B REVISED"):
        return "skip"
    facts, _, res = inspect(find("22541 B REVISED"))
    r = rule(res, "OPACITY_VARIATION_PRESENT")
    if r["status"] != "flag":
        return f"expected flag, got {r['status']}"
    if not facts["alphas"]:
        return "no alpha values captured"
    return True


def t_untrapped_but_bounded_passes(need):
    """A colour enclosed by another ink needs no choke. #22583 is the case."""
    if not need("22583 B"):
        return "skip"
    _, ctx, res = inspect(find("22583 B"))
    if ctx.get("trap_stroke_count", 0) != 0:
        return "fixture changed: expected no trap strokes"
    r = rule(res, "TRAP_AT_NEGATIVE_SPACE")
    return True if r["status"] == "pass" else f"got {r['status']}: {r['headline']}"


def t_ampersand_swatch_name(need):
    """#22591 carries '1-160&10-160-White&Navy 289' - legitimate, no spaces."""
    if not need("22591 F"):
        return "skip"
    _, _, res = inspect(find("22591 F"))
    r = rule(res, "SWATCH_NAME_STRUCTURE")
    return True if r["status"] == "pass" else f"got {r['status']}: {r['data']}"


def t_gradient_suppresses_unreliable_checks(need):
    """`sh` shading carries no colorant, so two rules must stand down."""
    if not need("22617 B"):
        return "skip"
    _, _, res = inspect(find("22617 B"))
    if rule(res, "GRADIENT_BLEND_ACROSS_ARTBOARDS")["status"] != "flag":
        return "gradient not flagged"
    for code in ("ARTWORK_IN_REGISTER", "NO_EMPTY_PLATES"):
        st = rule(res, code)["status"]
        if st != DT.CANNOT_EVALUATE:
            return (f"{code} should report cannot_evaluate when shading is "
                    f"present, got {st}")
    return True


def t_live_text_rule_is_quiet(need):
    """Rewritten to test position, not layer or ink. Must not cry wolf."""
    noisy = []
    for stem in ("22499 F", "22583 B", "22591 F", "11302 B"):
        p = need(stem)
        if not p:
            return "skip"
        _, _, res = inspect(p)
        r = rule(res, "ART_TEXT_OUTLINED")
        if r["status"] != "pass":
            noisy.append(f"{stem}: {r['status']}")
    return True if not noisy else f"fired on {noisy}"


def t_knockout_mask_matches_the_rip(need):
    """The choke is a zero-ink stroke, not removed geometry. The isolated plate
    must be masked with it or it comes out at full un-choked size."""
    p = need("22906 LC OUTPUT 1") or need("22499 F")
    if not p:
        return "skip"
    src = find("22906 LC OUTPUT 1") or find("22499 F")
    facts = EX.extract(src)
    under = [ab for ab in facts["artboards"] if ab["is_underbase"]]
    if not under:
        return "fixture has no underbase artboard"
    page = under[0]["index"]
    ink = under[0]["inks"][0]
    ko = VEC.knockout_svg(src, page - 1)
    if not ko:
        return "no knockout strokes found on the base"
    plate, _ = VEC.plate_svg(src, page - 1, ink)
    composed = VEC.compose_knockout(VEC.recolour(plate, "#e50695"), ko)
    if not VEC.is_well_formed(composed):
        return "composed SVG is not well formed"
    # Check the mask exists BEFORE checking its colours. Without this the
    # colour assertions below fire for any cause at all and name the wrong one.
    if "<mask" not in composed:
        return ("no <mask> in the composed plate - compose_knockout did not "
                "build one; check the renderer's SVG header format first")
    if 'fill="#ffffff"' not in composed:
        return "mask rect is not white - recolour ran after compose"
    if 'stroke="#000000"' not in composed:
        return "knockout strokes are not black - mask will not carve"
    return True


def t_svg_dimensions_parse_in_both_renderer_formats(need):
    """MuPDF 1.23 writes width="1152pt"; 1.25 writes width="1152".

    A parser that insists on one spelling silently stops masking and shows an
    un-choked plate, which looks entirely correct. Both must compose, the unit
    must survive the round trip unchanged, and a header we cannot read at all
    must raise rather than quietly hand back the plate.
    """
    src = find("22906 LC OUTPUT 1") or find("22499 F")
    if not src:
        return "skip"
    facts = EX.extract(src)
    under = [ab for ab in facts["artboards"] if ab["is_underbase"]]
    if not under:
        return "fixture has no underbase artboard"
    page, ink = under[0]["index"], under[0]["inks"][0]
    ko = VEC.knockout_svg(src, page - 1)
    plate, _ = VEC.plate_svg(src, page - 1, ink)
    if not ko or not plate:
        return "no knockout strokes found on the base"

    import re as _re
    # Construct BOTH spellings explicitly: recent MuPDF already emits unitless
    # dimensions, so the native output cannot be assumed to be the pt case.
    def dimensions(s, unit):
        opening = VEC.SVG_OPEN.search(s)
        if not opening:
            raise AssertionError("fixture SVG has no opening tag")
        header = _re.sub(r'(\b(?:width|height)=")([\d.]+)(?:pt)?(")',
                         lambda m: m.group(1) + m.group(2) + unit + m.group(3),
                         opening.group(0))
        return s[:opening.start()] + header + s[opening.end():]
    bodies = {}
    for label, p, k in (("pt", dimensions(plate, "pt"), dimensions(ko, "pt")),
                        ("unitless", dimensions(plate, ""), dimensions(ko, ""))):
        out = VEC.compose_knockout(p, k)
        if "<mask" not in out or 'fill="#ffffff"' not in out:
            return f"{label} dimensions did not produce a mask"
        want_pt = (label == "pt")
        if ('pt"' in out.split(">", 1)[0]) is not want_pt:
            return f"{label} dimensions were rewritten with the wrong unit"
        bodies[label] = out.split("\n", 1)[1]
    if bodies["pt"] != bodies["unitless"]:
        return "mask geometry differs between the two dimension formats"

    try:
        VEC.compose_knockout("<svg><g/></svg>", ko)
    except VEC.ChokeCompositionError:
        return True
    return "an unreadable SVG header returned a plate instead of raising"


def t_severity_comes_from_the_table(need):
    """A detector reports a condition; the CSV decides how loud it is."""
    table = RUN.load_table()
    row = next((r for r in table if r["code"] == "UNDERBASE_CHOKE_PER_OBJECT"), None)
    if row is None:
        return "rule missing from table"
    if row["severity"] != "info":
        return ("UNDERBASE_CHOKE_PER_OBJECT must be info - it reports the trap "
                f"sum, it does not require one. Table says {row['severity']}.")
    row2 = next((r for r in table if r["code"] == "CHOKE_SAFE_FOR_DETAIL"), None)
    if row2 and row2["enabled"].lower() != "false":
        return "CHOKE_SAFE_FOR_DETAIL is uncalibrated and must stay disabled"
    return True


def t_colourway_pair_is_not_a_revision(need):
    """#22906 '1' and '2' differ only by ink - same geometry to 0.001pt."""
    a = need("22906 LC OUTPUT 1")
    b = need("22906 LC OUTPUT 2")
    if not (a and b):
        return "skip"
    fa, fb = EX.extract(a), EX.extract(b)
    for x, y in zip(fa["artboards"], fb["artboards"]):
        ba = list(x["ink_bbox"].values())
        bb = list(y["ink_bbox"].values())
        if len(ba) != len(bb):
            return "different plate counts"
        for u, v in zip(sorted(ba), sorted(bb)):
            if max(abs(p - q) for p, q in zip(u, v)) > 0.001:
                return f"geometry differs: {u} vs {v}"
    if fa["all_inks"] == fb["all_inks"]:
        return "expected different inks between the two colourways"
    return True


def t_thresholds_come_from_the_table(need):
    """Move the trap band in the CSV and the verdict must move with it.

    This is the guarantee a rule-admin screen depends on. If a threshold is
    hardcoded, editing the table changes nothing and the screen lies.
    """
    if not need("22583 B"):
        return "skip"
    src = find("22583 B")
    facts = EX.extract(src)
    ctx = RUN.build_ctx(src, facts)

    base = rule(DT.evaluate(facts, ctx, RUN.load_table()), "TRAP_AT_NEGATIVE_SPACE")
    if base["status"] != DT.PASS:
        return f"fixture changed: expected a pass, got {base['status']}"

    # demand near-total enclosure; the same file must now fall short
    strict = patched_table("TRAP_AT_NEGATIVE_SPACE", expected=json.dumps({
        "trap_required_below_pct": 99, "trap_not_required_above_pct": 99.5}))
    moved = rule(DT.evaluate(facts, ctx, strict), "TRAP_AT_NEGATIVE_SPACE")
    if moved["status"] == DT.PASS:
        return ("threshold is hardcoded - raising it in the table did not change "
                "the verdict")
    return True


def t_register_tolerance_comes_from_the_table(need):
    """Same guarantee on a second rule, with a tolerance rather than a band."""
    if not need("22499 F"):
        return "skip"
    src = find("22499 F")
    facts = EX.extract(src)
    ctx = RUN.build_ctx(src, facts)
    pair = ctx.get("register_pair")
    if not pair:
        return "fixture changed: no register pair"
    # Inject a known nonzero delta. The natural fixture is exactly aligned, so
    # merely setting tolerance to zero cannot prove the table is consulted.
    ctx["register_pair"] = (pair[0], pair[1], [0.01, 0.0, 0.0, 0.0])
    strict = patched_table("ARTWORK_IN_REGISTER",
                           tolerance=json.dumps({"abs": 0.005, "unit": "pt"}))
    loose = patched_table("ARTWORK_IN_REGISTER",
                          tolerance=json.dumps({"abs": 0.02, "unit": "pt"}))
    failed = rule(DT.evaluate(facts, ctx, strict), "ARTWORK_IN_REGISTER")
    passed = rule(DT.evaluate(facts, ctx, loose), "ARTWORK_IN_REGISTER")
    if failed["status"] != DT.FAIL:
        return f"0.01pt must fail at 0.005pt tolerance, got {failed['status']}"
    if passed["status"] != DT.PASS:
        return f"0.01pt must pass at 0.02pt tolerance, got {passed['status']}"
    return True


def t_a_broken_detector_is_not_a_pass(need):
    """The important one. A detector that raises must be visible as an error,
    and the inspection must not describe itself as complete."""
    if not need("22499 F"):
        return "skip"
    src = find("22499 F")
    facts = EX.extract(src)
    ctx = RUN.build_ctx(src, facts)

    victim = "SWATCH_NAME_STRUCTURE"
    saved = DT.REGISTRY[victim]

    def boom(f, c, p):
        raise RuntimeError("simulated detector fault")

    DT.REGISTRY[victim] = boom
    try:
        res = DT.evaluate(facts, ctx, RUN.load_table())
        comp = DT.completeness(res)
    finally:
        DT.REGISTRY[victim] = saved

    r = rule(res, victim)
    if r["status"] != DT.ERROR:
        return f"a raising detector must report error, got {r['status']}"
    if comp["complete"]:
        return "an inspection with a failed detector must not report complete"
    if comp["errors"] != 1:
        return f"expected 1 error, counted {comp['errors']}"
    if not any(victim in u for u in comp["unverified"]):
        return "the failed rule must be named in the unverified list"
    return True


def t_unimplemented_rules_are_reported(need):
    """A rule in the table with no detector must be reported, not omitted.
    Silence about a rule reads as though it passed."""
    facts = {"filename": "x", "sha256_16": "0", "bytes": 0, "layers": [],
             "artboard_count": 0, "alphas": [], "blend_modes": [], "soft_masks": 0,
             "artboards": [], "all_inks": []}
    res = DT.evaluate(facts, {}, RUN.load_table())
    codes = {r["code"] for r in res}
    table = [r for r in RUN.load_table()
             if (r.get("enabled") or "true").lower() == "true"]
    missing = [r["code"] for r in table if r["code"] not in codes]
    if missing:
        return f"{len(missing)} enabled rule(s) omitted entirely: {missing[:3]}"
    without = [r["code"] for r in res if r["status"] == DT.NOT_IMPLEMENTED]
    if not without:
        return "expected some rules to report not_implemented"
    return True


def t_not_applicable_is_distinct_from_unverified(need):
    """The distinction the whole completeness model rests on."""
    a = need("22717 B")     # no underbase: several rules genuinely do not apply
    b = need("22617 B")     # gradients: checks that should have run, could not
    if not (a and b):
        return "skip"
    _, _, ra = inspect(a)
    _, _, rb = inspect(b)
    na = [r for r in ra if r["status"] == DT.NOT_APPLICABLE]
    cant = [r for r in rb if r["status"] == DT.CANNOT_EVALUATE]
    if not na:
        return "expected not_applicable rules on a file with no underbase"
    if not cant:
        return "expected cannot_evaluate rules on a file with gradients"
    if not DT.completeness(ra)["complete"]:
        return "not_applicable must not make an inspection incomplete"
    if DT.completeness(rb)["complete"]:
        return "cannot_evaluate must make an inspection incomplete"
    return True


TESTS = [
    ("register catches the planted 1pt nudge", t_register_catches_the_planted_nudge),
    ("register passes a good file", t_register_passes_a_good_file),
    ("declared-but-unused plate is caught", t_declared_but_unused_plate),
    ("opacity below 100% is detected", t_opacity_is_detected),
    ("bounded colour needs no trap", t_untrapped_but_bounded_passes),
    ("ampersand swatch name accepted", t_ampersand_swatch_name),
    ("gradients suppress unreliable checks", t_gradient_suppresses_unreliable_checks),
    ("live-text rule stays quiet", t_live_text_rule_is_quiet),
    ("knockout mask survives recolour", t_knockout_mask_matches_the_rip),
    ("svg dimensions parse in both renderer formats",
     t_svg_dimensions_parse_in_both_renderer_formats),
    ("severity comes from the table", t_severity_comes_from_the_table),
    ("colourway pair, not a revision", t_colourway_pair_is_not_a_revision),
    ("thresholds come from the table", t_thresholds_come_from_the_table),
    ("register tolerance comes from the table", t_register_tolerance_comes_from_the_table),
    ("a broken detector is not a pass", t_a_broken_detector_is_not_a_pass),
    ("unimplemented rules are reported", t_unimplemented_rules_are_reported),
    ("not applicable is distinct from unverified", t_not_applicable_is_distinct_from_unverified),
]


def main():
    allow_skips = "--allow-skips" in sys.argv
    print(f"corpus: {CORPUS}")
    if not os.path.isdir(CORPUS):
        print("  not found - set PRINTSCOPE_CORPUS or pass a path\n")
    for name, fn in TESTS:
        check(name, fn)
    print()
    for n in PASSED:
        print(f"  PASS  {n}")
    for n, why in SKIPPED:
        print(f"  SKIP  {n}  ({why})")
    for n, why in FAILED:
        print(f"  FAIL  {n}\n        {why}")
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed, {len(SKIPPED)} skipped")

    # A skip means a test did not run. Treated as success it produces exactly
    # the false reassurance this suite exists to prevent, so it is fatal unless
    # someone deliberately asks otherwise.
    if SKIPPED and not allow_skips:
        print("\nFAILED: tests were skipped. The baseline requires the full "
              "corpus - point PRINTSCOPE_CORPUS at it, or pass --allow-skips "
              "if you accept an incomplete run.")
        return 1
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
