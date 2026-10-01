"""PrintScope EXTRACT layer.

Turns a PDF-compatible .ai file into a plain dict of facts. Knows nothing about
rules, severity or presentation. Every downstream consumer reads this dict.
"""
import math, os, re, hashlib
import pikepdf
from pikepdf import Dictionary, Name, Array, parse_content_stream
from consultant_extract import colorant_details, decode_text, image_placement

PAINT_FILL = ("f", "F", "f*")
PAINT_STROKE = ("S", "s")
PAINT_BOTH = ("B", "B*", "b", "b*")
PAINT_ALL = PAINT_FILL + PAINT_STROKE + PAINT_BOTH


def mul(m, n):
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a*A + b*C, a*B + b*D, c*A + d*C, c*B + d*D, e*A + f*C + E, e*B + f*D + F)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a*x + c*y + e, b*x + d*y + f)


def _scale(m):
    return math.sqrt(abs(m[0]*m[3] - m[1]*m[2])) or 1.0


def _colorspace_name(res, nm):
    """Resolve a named colourspace to an ink name, or a device/ICC marker."""
    if nm in ("/DeviceCMYK", "/DeviceRGB", "/DeviceGray"):
        return {"/DeviceCMYK": "@devicek", "/DeviceRGB": "@devicerg",
                "/DeviceGray": "@deviceg"}[nm]
    try:
        o = res.get("/ColorSpace")[nm]
    except Exception:
        return None
    if str(o) in ("/DeviceCMYK", "/DeviceRGB", "/DeviceGray"):
        return {"/DeviceCMYK": "@devicek", "/DeviceRGB": "@devicerg",
                "/DeviceGray": "@deviceg"}[str(o)]
    try:
        kind = str(o[0])
    except Exception:
        return str(o)[1:].lower() if str(o).startswith("/") else None
    if kind == "/Separation":
        return str(o[1])[1:]
    if kind == "/DeviceN":
        try:
            return "&".join(str(x)[1:] for x in o[1])
        except Exception:
            return "DeviceN"
    if kind == "/ICCBased":
        return "@iccbased"
    return "@" + kind[1:].lower()


def _ocg_name(res, nm):
    try:
        o = res.get("/Properties")[nm]
        if str(o.get("/Type")) == "/OCMD":
            g = o.get("/OCGs")
            o = g[0] if isinstance(g, Array) else g
        return str(o.get("/Name"))
    except Exception:
        return None


def declared_colorants(pg):
    """Separations declared in the resource dictionaries, painted or not."""
    found = set()
    seen = set()

    def rec(res, d=0):
        if res is None or d > 8:
            return
        cs = res.get("/ColorSpace")
        if cs is not None:
            for k in cs.keys():
                try:
                    o = cs[k]
                    kind = str(o[0])
                except Exception:
                    continue
                if kind == "/Separation":
                    found.add(str(o[1])[1:])
                elif kind == "/DeviceN":
                    try:
                        for x in o[1]:
                            found.add(str(x)[1:])
                    except Exception:
                        pass
        xo = res.get("/XObject")
        if xo is not None:
            for k in xo.keys():
                try:
                    x = xo[k]
                except Exception:
                    continue
                if x.get("/Subtype") == Name("/Form"):
                    oid = x.objgen
                    if oid in seen:
                        continue
                    seen.add(oid)
                    rec(x.get("/Resources"), d + 1)

    rec(pg.get("/Resources"))
    return sorted(found)


def _layer_list(pdf):
    try:
        return [str(o.Name) for o in pdf.Root.OCProperties.OCGs]
    except Exception:
        return []


def _gstate_scan(pdf):
    """Alpha, blend modes and soft masks, recursed through form XObjects."""
    alphas, blends = set(), set()
    smasks = 0
    seen = set()

    def rec(res, depth=0):
        nonlocal smasks
        if res is None or depth > 10:
            return
        gs = res.get("/ExtGState")
        if gs is not None:
            for k in gs.keys():
                g = gs[k]
                for key in ("/ca", "/CA"):
                    v = g.get(key)
                    if v is not None:
                        try:
                            fv = float(v)
                            if fv < 1.0:
                                alphas.add(round(fv, 3))
                        except Exception:
                            pass
                b = g.get("/BM")
                if b is not None:
                    s = str(b[0]) if isinstance(b, Array) else str(b)
                    if s not in ("/Normal", "/Compatible"):
                        blends.add(s[1:])
                sm = g.get("/SMask")
                if sm is not None and str(sm) != "/None":
                    smasks += 1
        xo = res.get("/XObject")
        if xo is not None:
            for k in xo.keys():
                try:
                    x = xo[k]
                except Exception:
                    continue
                if x.get("/Subtype") == Name("/Form"):
                    oid = x.objgen
                    if oid in seen:
                        continue
                    seen.add(oid)
                    rec(x.get("/Resources"), depth + 1)

    for pg in pdf.pages:
        rec(pg.get("/Resources"))
    return sorted(alphas), sorted(blends), smasks


def scan_page(pg):
    """Walk one artboard's content, recursing into form XObjects.

    Returns a dict of shapes, strokes, text runs, layer tallies and colorants.
    """
    out = {
        "shapes": [],      # {ink, layer, bbox}
        "strokes": [],     # {w, ink, layer, bbox}
        "text_runs": [],   # {layer}
        "layer_paint": {},
        "colorants": set(),
        "nonsep_fills": {},
        "shadings": 0,
        "images": 0,
        "image_placements": [],
        "fill_stroke_pairs": [],
    }

    def walk(obj, res, ctm, fill, strk, lw, layer, depth=0, stroke_values=None, font=None):
        if res is None or depth > 12:
            return
        xo = res.get("/XObject")
        stack, lstack, pts = [], [], []
        M, F, S, W, L = ctm, fill, strk, lw, layer
        SV, FT = stroke_values, font
        tm = tlm = None
        leading = 0.0
        try:
            stream = parse_content_stream(obj)
        except Exception:
            return
        for op_obj in stream:
            op = str(op_obj.operator)
            a = op_obj.operands
            try:
                if op == "q":
                    stack.append((M, F, S, W, SV, FT))
                elif op == "Q":
                    if stack:
                        M, F, S, W, SV, FT = stack.pop()
                elif op == "cm":
                    M = mul(tuple(float(x) for x in a), M)
                elif op == "cs":
                    F = _colorspace_name(res, str(a[0]))
                elif op == "CS":
                    S = _colorspace_name(res, str(a[0]))
                    SV = [0, 0, 0, 1] if S == "@devicek" else None
                elif op in ("k", "rg", "g"):
                    F = "@device" + op
                elif op in ("K", "RG", "G"):
                    S = "@device" + op.lower()
                    SV = [float(x) for x in a]
                elif op in ("SC", "SCN"):
                    SV = [float(x) for x in a]
                elif op == "w":
                    W = float(a[0])
                elif op == "sh":
                    out["shadings"] += 1
                elif op == "BDC":
                    lstack.append(L)
                    if str(a[0]) == "/OC":
                        n = _ocg_name(res, str(a[1]))
                        if n:
                            L = n
                elif op == "BMC":
                    lstack.append(L)
                elif op == "EMC":
                    if lstack:
                        L = lstack.pop()
                elif op in ("m", "l"):
                    pts.append(apply(M, float(a[0]), float(a[1])))
                elif op == "c":
                    for i in range(0, 6, 2):
                        pts.append(apply(M, float(a[i]), float(a[i + 1])))
                elif op in ("v", "y"):
                    for i in range(0, 4, 2):
                        pts.append(apply(M, float(a[i]), float(a[i + 1])))
                elif op == "re":
                    x, y, w, h = [float(v) for v in a]
                    for px, py in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
                        pts.append(apply(M, px, py))
                elif op == "BT":
                    tm = tlm = (1, 0, 0, 1, 0, 0)
                elif op == "Tf":
                    FT = res.get("/Font", {}).get(str(a[0]))
                elif op == "ET":
                    tm = tlm = None
                elif op == "Tm":
                    tm = tlm = tuple(float(x) for x in a)
                elif op in ("Td", "TD"):
                    if tlm is not None:
                        tlm = mul((1, 0, 0, 1, float(a[0]), float(a[1])), tlm)
                        tm = tlm
                elif op == "T*":
                    if tlm is not None:
                        tlm = mul((1, 0, 0, 1, 0, -leading), tlm)
                        tm = tlm
                elif op == "TL":
                    leading = float(a[0])
                elif op in ("Tj", "TJ", "'", '"'):
                    pos = None
                    if tm is not None:
                        full = mul(tm, M)
                        pos = [round(full[4], 2), round(full[5], 2)]
                    text, error = decode_text(a, op, FT)
                    out["text_runs"].append({"layer": str(L), "ink": F, "pos": pos,
                                             "text": text, "decode_error": error})
                elif op in PAINT_ALL or op == "n":
                    if op != "n":
                        out["layer_paint"][str(L)] = out["layer_paint"].get(str(L), 0) + 1
                    bb = None
                    if pts:
                        xs = [p[0] for p in pts]
                        ys = [p[1] for p in pts]
                        bb = [min(xs), min(ys), max(xs), max(ys)]
                    if op in PAINT_FILL + PAINT_BOTH and F:
                        if F.startswith("@"):
                            out["nonsep_fills"][F[1:]] = out["nonsep_fills"].get(F[1:], 0) + 1
                        else:
                            out["colorants"].add(F)
                        out["shapes"].append({"ink": F, "layer": str(L), "bbox": bb})
                    if op in PAINT_STROKE + PAINT_BOTH:
                        if S and not S.startswith("@"):
                            out["colorants"].add(S)
                        out["strokes"].append({
                            "w": round(W * _scale(M), 4), "ink": S,
                            "layer": str(L), "bbox": bb,
                        })
                    if op in PAINT_BOTH:
                        out["fill_stroke_pairs"].append({
                            "fill": F, "stroke": S, "w": round(W * _scale(M), 4),
                            "layer": str(L), "bbox": bb,
                            "is_choke": S == "@devicek" and SV == [0, 0, 0, 0],
                        })
                    pts = []
                elif op in ("W", "W*"):
                    pass
                elif op == "Do" and xo is not None:
                    try:
                        x = xo[str(a[0])]
                    except Exception:
                        continue
                    if x.get("/Subtype") == Name("/Form"):
                        mtx = x.get("/Matrix")
                        M2 = mul(tuple(float(v) for v in mtx), M) if mtx is not None else M
                        walk(x, x.get("/Resources", res), M2, F, S, W, L, depth + 1, SV, FT)
                    elif x.get("/Subtype") == Name("/Image"):
                        out["images"] += 1
                        try:
                            placement = image_placement(x, M, res, L, str(a[0]))
                        except Exception as exc:
                            placement = {"name": str(a[0]), "layer": str(L),
                                         "effective_dpi": None, "colorspace": "unknown",
                                         "extraction_error": f"{type(exc).__name__}: {exc}"}
                        out["image_placements"].append(placement)
            except Exception:
                pass

    walk(pg, pg.get("/Resources", Dictionary()), (1, 0, 0, 1, 0, 0), None, None, 1.0, None)
    out["colorants"] = sorted(out["colorants"])
    return out


UNDER_RE = re.compile(r"under", re.I)


def extract(path):
    """Full fact extraction for one file."""
    pdf = pikepdf.Pdf.open(path)
    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()[:16]

    alphas, blends, smasks = _gstate_scan(pdf)
    facts = {
        "filename": os.path.basename(path),
        "sha256_16": digest,
        "bytes": os.path.getsize(path),
        "layers": _layer_list(pdf),
        "artboard_count": len(pdf.pages),
        "alphas": alphas,
        "blend_modes": blends,
        "soft_masks": smasks,
        "artboards": [],
    }

    for i, pg in enumerate(pdf.pages):
        mb = [float(x) for x in pg.MediaBox]
        s = scan_page(pg)
        inks = [c for c in s["colorants"] if c != "All"]
        decl = declared_colorants(pg)
        has_all = "All" in s["colorants"] or "All" in decl
        ab = {
            "index": i + 1,
            "width_in": round((mb[2] - mb[0]) / 72.0, 3),
            "height_in": round((mb[3] - mb[1]) / 72.0, 3),
            "inks": inks,
            "has_all_colorant": has_all,
            "declared_inks": [d for d in decl if d != "All"],
            "is_underbase": any(UNDER_RE.search(c) for c in inks) and len(inks) == 1,
            "paint_ops": sum(s["layer_paint"].values()),
            "layer_paint": s["layer_paint"],
            "nonsep_fills": s["nonsep_fills"],
            "shadings": s["shadings"],
            "images": s["images"],
            "image_placements": s["image_placements"],
            "fill_stroke_pairs": s["fill_stroke_pairs"],
            "colorant_details": colorant_details(pg),
            "label_text_runs": s["text_runs"],
            "text_runs": len(s["text_runs"]),
            "text_by_layer": _tally(s["text_runs"]),
            "text_by_ink": _tally_ink(s["text_runs"]),
            "text_positions": [r["pos"] for r in s["text_runs"] if r.get("pos")],
            "strokes": _stroke_summary(s["strokes"]),
            "ink_bbox": _ink_bbox(s["shapes"]),
        }
        facts["artboards"].append(ab)

    facts["all_inks"] = sorted({i for ab in facts["artboards"] for i in ab["inks"]})
    return facts


def _tally_ink(runs):
    t = {}
    for r in runs:
        k = r.get("ink") or "(none)"
        t[k] = t.get(k, 0) + 1
    return t


def _tally(runs):
    t = {}
    for r in runs:
        t[r["layer"]] = t.get(r["layer"], 0) + 1
    return t


def _stroke_summary(strokes):
    t = {}
    for s in strokes:
        key = f"{s['w']}|{s['ink']}"
        t[key] = t.get(key, 0) + 1
    return t


def _ink_bbox(shapes):
    out = {}
    for s in shapes:
        if not s["ink"] or s["ink"].startswith("@") or s["ink"] == "All" or not s["bbox"]:
            continue
        bb = out.setdefault(s["ink"], [1e9, 1e9, -1e9, -1e9])
        b = s["bbox"]
        bb[0] = min(bb[0], b[0]); bb[1] = min(bb[1], b[1])
        bb[2] = max(bb[2], b[2]); bb[3] = max(bb[3], b[3])
    return {k: [round(x, 3) for x in v] for k, v in out.items()}
