"""PrintScope runner: file in, result JSON out, viewer rebuilt."""
import base64, csv, hashlib, io, json, os, subprocess, sys, tempfile, shutil, glob, datetime, uuid
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract as EX
import detect as DT
import raster as RS
import vector as VEC

import config as CFG

HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE = CFG.QUEUE_DIR
RULES = CFG.RULES_CSV
PREVIEW_DPI = 170
FALLBACK_DPI = CFG.FALLBACK_DPI
PREVIEW_MAX_W = 1500


def load_table():
    with open(RULES) as fh:
        return list(csv.DictReader(fh))


def rules_version():
    """A fingerprint of the rule table as it was when this verdict was made.

    Thresholds and severities are editable by design, so a verdict is only
    meaningful alongside the rules it was judged against.
    """
    try:
        with open(RULES, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:12]
    except Exception:
        return "unknown"


# ------------------------------------------------------------------ previews

SITE = CFG.SITE_DIR


# Same unit tolerance as vector.WH - MuPDF 1.23 emits pt, 1.25 emits unitless.
# When this failed to match, w/h came back 0, which silently switched off the
# art bounding box and with it the zoom-to-artwork behaviour.
SVGSIZE = __import__("re").compile(
    r'width="([\d.]+)\s*(?:pt|px|mm|cm|in|pc|em|ex|%)?"'
    r'\s+height="([\d.]+)\s*(?:pt|px|mm|cm|in|pc|em|ex|%)?"')


def _save_svg(svg, relpath):
    full = os.path.join(SITE, relpath)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as fh:
        fh.write(svg)
    m = SVGSIZE.search(svg)
    w = float(m.group(1)) if m else 0
    h = float(m.group(2)) if m else 0
    return relpath, w, h


def _save_mask(mask, relpath, rgb):
    """Two-colour palette PNG: transparent ground, one ink colour. Small enough
    to stack a dozen plates in a page and still load instantly on an iPad."""
    idx = np.where(mask, 1, 0).astype(np.uint8)
    img = Image.fromarray(idx, "P")
    pal = [255, 255, 255] + list(rgb) + [0] * (256 * 3 - 6)
    img.putpalette(pal)
    img.info["transparency"] = 0
    if img.width > PREVIEW_MAX_W:
        h = max(int(img.height * PREVIEW_MAX_W / img.width), 1)
        img = img.resize((PREVIEW_MAX_W, h), Image.NEAREST)
    full = os.path.join(SITE, relpath)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    img.save(full, "PNG", optimize=True, transparency=0)
    return relpath, img.width, img.height


INK_COLOURS = [
    (24, 24, 27), (220, 38, 38), (37, 99, 235), (22, 163, 74),
    (234, 88, 12), (147, 51, 234), (13, 148, 136), (190, 24, 93),
    (161, 98, 7), (71, 85, 105),
]


# The swatch name carries the colour. Show the plate in something close to the
# ink it will actually print in - a green plate rendered red is worse than useless
# to someone checking a separation.
NAMED = [
    ("rhodamine", (226, 0, 122)), ("magenta", (219, 0, 138)),
    ("maroon", (128, 32, 48)), ("burgundy", (120, 34, 52)),
    ("navy", (26, 42, 84)), ("royal", (30, 66, 168)),
    ("teal", (14, 122, 125)), ("turquoise", (26, 150, 160)),
    ("dk blue", (26, 52, 104)), ("lt blue", (96, 156, 210)),
    ("blue", (30, 86, 176)), ("green", (32, 122, 66)),
    ("lime", (120, 176, 48)), ("olive", (104, 110, 52)),
    ("red", (196, 38, 34)), ("orange", (226, 108, 30)),
    ("gold", (186, 146, 40)), ("yellow", (226, 194, 42)),
    ("tan", (186, 154, 116)), ("brown", (118, 78, 52)),
    ("purple", (108, 52, 140)), ("violet", (116, 60, 156)),
    ("pink", (226, 128, 160)), ("grey", (128, 138, 140)),
    ("gray", (128, 138, 140)), ("silver", (170, 178, 180)),
    ("blk", (26, 26, 28)), ("black", (26, 26, 28)),
    ("cream", (232, 222, 198)), ("natural", (224, 214, 194)),
]


def _ink_rgb(name, i):
    n = name.lower()
    if "under" in n:
        return (236, 72, 153)          # Rhodamine, as the shop marks the base
    if "white" in n:
        return (150, 160, 166)         # white needs a visible stand-in
    for word, rgb in NAMED:
        if word in n:
            return rgb
    return INK_COLOURS[i % len(INK_COLOURS)]


def previews(src, facts, slug):
    """One file per plate.

    Vector first: the source is vector, so the preview should be too - an SVG
    plate stays clean at any zoom instead of going sawtoothed. A file dense
    enough to blow the SVG size budget falls back to a high-resolution
    antialiased raster for that plate only.
    """
    out = []
    for ab in facts["artboards"]:
        page = ab["index"]
        layers, w, h, fell_back = [], 0, 0, 0
        choke_failed = []
        inks = [i for i in ab["inks"] if i != "All"]

        raster_cache = None
        # A choke is a zero-ink stroke painted across the edge with overprint
        # off, not geometry that was removed - so the colorant filter cannot see
        # it and an isolated plate comes out at full un-choked size. Carve those
        # strokes back out so the preview matches what the RIP burns.
        ko = VEC.knockout_svg(src, page - 1)
        for i, name in enumerate(sorted(inks)):
            safe = "".join(c if c.isalnum() else "_" for c in name)[:40]
            svg, size = VEC.plate_svg(src, page - 1, name)
            if svg:
                # Recolour FIRST. compose_knockout builds a luminance mask out of
                # a white rect and black strokes; recolouring afterwards rewrites
                # both to the ink colour, which flattens the mask and silently
                # removes the choke it was carving.
                rgb_fallback = _ink_rgb(name, i)
                col = VEC.ink_colour(svg, "#%02x%02x%02x" % rgb_fallback)
                svg = VEC.recolour(svg, col)
                if ko:
                    try:
                        composed = VEC.compose_knockout(svg, ko)
                    except VEC.ChokeCompositionError as exc:
                        composed = None
                        choke_failed.append(f"{name}: {exc}")
                    if composed is None:
                        pass
                    elif VEC.is_well_formed(composed):
                        svg = composed
                    else:
                        choke_failed.append(
                            f"{name}: composed plate is not well-formed XML")
                rel, w, h = _save_svg(svg, f"img/{slug}/ab{page}_{safe}.svg")
                layers.append({"ink": name, "colour": col, "src": rel,
                               "kind": "svg", "bytes": len(svg)})
                continue

            # fallback: antialiased raster at press-review resolution
            fell_back += 1
            if raster_cache is None:
                try:
                    raster_cache = RS.plates(src, page, FALLBACK_DPI)
                except Exception:
                    raster_cache = {}
            m = raster_cache.get(name)
            if m is None:
                continue
            rgb = _ink_rgb(name, i)
            rel, w, h = _save_mask(m, f"img/{slug}/ab{page}_{safe}.png", rgb)
            layers.append({"ink": name, "colour": "#%02x%02x%02x" % rgb,
                           "src": rel, "kind": "png"})

        # Art bounding box in display (SVG) coordinates, so the viewer can
        # centre on the artwork rather than on the middle of a 16in board that
        # is mostly empty.
        art = None
        bb = [1e9, 1e9, -1e9, -1e9]
        for val in ab["ink_bbox"].values():
            bb[0] = min(bb[0], val[0]); bb[1] = min(bb[1], val[1])
            bb[2] = max(bb[2], val[2]); bb[3] = max(bb[3], val[3])
        if bb[2] > -1e8 and h:
            hpt = ab["height_in"] * 72.0
            art = [round(bb[0], 2), round(hpt - bb[3], 2),
                   round(bb[2], 2), round(hpt - bb[1], 2)]

        out.append({"index": page, "w": w, "h": h, "art": art,
                    "is_underbase": bool(ab["is_underbase"]),
                    "choked": bool(ko) and not choke_failed,
                    "choke_failed": choke_failed,
                    "plates": layers, "raster_fallbacks": fell_back})
    return out


# ------------------------------------------------------------------ context

def build_ctx(src, facts):
    ctx = {}
    unders = [ab for ab in facts["artboards"] if ab["is_underbase"]]
    colours = [ab for ab in facts["artboards"] if not ab["is_underbase"] and ab["inks"]]
    ctx["has_underbase"] = bool(unders)

    # trap strokes: narrow widths, on art, excluding guide furniture
    trap = {}
    for ab in facts["artboards"]:
        for key, n in ab["strokes"].items():
            w_s, ink = key.split("|", 1)
            w = float(w_s)
            if w <= 0 or w > 2.0:
                continue
            trap[(w, ink)] = trap.get((w, ink), 0) + n
    ctx["trap_strokes"] = trap
    ctx["trap_stroke_count"] = sum(trap.values())

    # which colours actually sit on the base — only those can be out of register
    if unders and colours:
        try:
            cov, based = RS.base_coverage(src, colours[0]["index"], unders[0]["index"])
            ctx["coverage"] = cov
            ctx["based_inks"] = based
        except Exception as e:
            ctx["coverage_error"] = str(e)
            based = []

        def union(ab, only=None):
            bb = [1e9, 1e9, -1e9, -1e9]
            for k, val in ab["ink_bbox"].items():
                if only is not None and k not in only:
                    continue
                bb[0] = min(bb[0], val[0]); bb[1] = min(bb[1], val[1])
                bb[2] = max(bb[2], val[2]); bb[3] = max(bb[3], val[3])
            return [round(x, 3) for x in bb] if bb[2] > -1e8 else None

        c = union(colours[0], set(based)) if based else None
        u = union(unders[0])
        if c and u:
            ctx["register_pair"] = (c, u, [round(u[i] - c[i], 3) for i in range(4)])

    # perimeter adjacency on the primary colour artboard
    if colours:
        try:
            ctx["adjacency"] = RS.perimeter_adjacency(src, colours[0]["index"])
        except Exception as e:
            ctx["adjacency_error"] = str(e)
    if unders and colours and ctx.get("based_inks"):
        try:
            ctx["erosion"] = RS.erosion_topology(
                src, colours[0]["index"], only=set(ctx["based_inks"]))
        except Exception:
            pass
    return ctx


# ------------------------------------------------------------------ verdict

ORDER = {"fail": 0, "flag": 1, "pass": 2, "info": 3, "skip": 4}


def _jsonable_ctx(ctx):
    out = {}
    for k, val in ctx.items():
        if k == "adjacency":
            continue
        if k == "trap_strokes":
            out[k] = {f"{w}|{ink}": n for (w, ink), n in val.items()}
        else:
            out[k] = val
    return out


def overall(results):
    """The verdict is about what the rules FOUND. Whether enough rules ran to
    trust it is a separate question, answered by DT.completeness() - keeping
    them apart is what stops an inspection that half-failed from rendering as
    a clean pass."""
    if any(r["status"] == DT.FAIL for r in results):
        return "fail"
    if any(r["status"] == DT.FLAG for r in results):
        return "flag"
    return "pass"


def process(src, table):
    """Inspect one file. An inspection is identified by the bytes it judged,
    never by the filename - a vendor resending revised artwork under the same
    name must not overwrite the verdict on the previous version."""
    facts = EX.extract(src)
    stem = "".join(ch if ch.isalnum() else "_" for ch in facts["filename"])[:52]
    slug = f"{stem}__{facts['sha256_16'][:10]}"

    ctx = build_ctx(src, facts)
    results = DT.evaluate(facts, ctx, table)
    comp = DT.completeness(results)

    rec = {
        "inspection_id": str(uuid.uuid4()),
        "filename": facts["filename"],
        "sha256_16": facts["sha256_16"],
        "bytes": facts["bytes"],
        "inspected_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "engine_version": CFG.ENGINE_VERSION,
        "rules_version": rules_version(),
        "facts": facts,
        "ctx": _jsonable_ctx(ctx),
        "adjacency": ctx.get("adjacency", {}),
        "results": results,
        "verdict": overall(results),
        "completeness": comp,
        "previews": previews(src, facts, slug),
    }
    path = os.path.join(QUEUE, f"{slug}.json")
    with open(path, "w") as fh:
        json.dump(rec, fh)
    return rec, path


def main(paths):
    table = load_table()
    os.makedirs(QUEUE, exist_ok=True)
    done = []
    for p in paths:
        rec, path = process(p, table)
        c = rec["completeness"]
        mark = "" if c["complete"] else "  ** INCOMPLETE **"
        print(f"{rec['verdict'].upper():5} {rec['filename']:36} "
              f"judged={c['judged']} n/a={c['not_applicable']} "
              f"unverified={c['cannot_evaluate']} "
              f"not-impl={c['not_implemented']} errors={c['errors']}{mark}")
        for r in rec["results"]:
            if r["status"] in (DT.FAIL, DT.FLAG):
                print(f"        [{r['status']}] {r['code']}: {r['headline']}")
        for line in c["unverified"]:
            print(f"        [unverified] {line}")
        done.append(path)
    return done


if __name__ == "__main__":
    main(sys.argv[1:])
