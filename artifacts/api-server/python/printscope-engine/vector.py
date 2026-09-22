"""Vector plate extraction.

The source files are vector, so the preview should be too. For each separation
we rewrite the page's content stream, turning every paint operator that does not
use that colorant into a no-op, then let mutool render the result to SVG. The
geometry survives intact, so the plate stays crisp at any zoom instead of
degrading into the sawtooth edges a raster preview gives you.
"""
import os, re, subprocess, tempfile
import pikepdf
from pikepdf import Name, Array, Dictionary, parse_content_stream, unparse_content_stream

import config as CFG

PAINT_FILL = {"f", "F", "f*"}
PAINT_STROKE = {"S", "s"}
PAINT_BOTH = {"B", "B*", "b", "b*"}
PAINT = PAINT_FILL | PAINT_STROKE | PAINT_BOTH
SHOW_TEXT = {"Tj", "TJ", "'", '"'}


def _csname(res, nm):
    try:
        o = res.get("/ColorSpace")[nm]
        kind = str(o[0])
    except Exception:
        return None
    if kind == "/Separation":
        return str(o[1])[1:]
    if kind == "/DeviceN":
        try:
            return "&".join(str(x)[1:] for x in o[1])
        except Exception:
            return "DeviceN"
    return "@" + kind[1:].lower()


def _filter_stream(pdf, obj, res, target, seen):
    """Rewrite one content stream in place, keeping only `target` colorant."""
    try:
        ops = list(parse_content_stream(obj))
    except Exception:
        return
    out = []
    stack = []
    fill = strk = None
    for o in ops:
        op = str(o.operator)
        a = o.operands
        try:
            if op == "q":
                stack.append((fill, strk))
            elif op == "Q":
                if stack:
                    fill, strk = stack.pop()
            elif op == "cs":
                fill = _csname(res, str(a[0]))
            elif op == "CS":
                strk = _csname(res, str(a[0]))
            elif op in ("k", "rg", "g"):
                fill = "@device"
            elif op in ("K", "RG", "G"):
                strk = "@device"
        except Exception:
            pass

        if op in SHOW_TEXT and fill != target:
            # Text paints without an `f` operator. The swatch labels ARE printed
            # in their own ink and belong on the plate; the filename line is set
            # in registration black and does not.
            continue

        if op in PAINT:
            keeps_fill = op in (PAINT_FILL | PAINT_BOTH) and fill == target
            keeps_strk = op in (PAINT_STROKE | PAINT_BOTH) and strk == target
            if not (keeps_fill or keeps_strk):
                out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("n")))
                continue
            if op in PAINT_BOTH and not (keeps_fill and keeps_strk):
                op2 = "f" if keeps_fill else "S"
                out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator(op2)))
                continue
        out.append(o)

    data = unparse_content_stream(out)
    if "/Contents" in obj:                     # a Page, not a Stream
        obj.Contents = pdf.make_stream(data)
    else:
        obj.write(data)

    xo = res.get("/XObject") if res is not None else None
    if xo is None:
        return
    for k in xo.keys():
        try:
            x = xo[k]
        except Exception:
            continue
        if x.get("/Subtype") != Name("/Form"):
            continue
        oid = x.objgen
        if oid in seen:
            continue
        seen.add(oid)
        _filter_stream(pdf, x, x.get("/Resources", res), target, seen)


def _filter_knockout(pdf, obj, res, seen):
    """Keep ONLY the zero-ink knockout strokes: narrow strokes painted in a
    device colourspace. That is what a choke actually is - overprint is off, so
    painting CMYK 0,0,0,0 across the edge writes 0% to the spot plate and eats
    into it. Reg-mark fills are device-coloured too, so restricting to strokes
    under 2pt keeps the furniture out of the mask."""
    try:
        ops = list(parse_content_stream(obj))
    except Exception:
        return
    out, stack = [], []
    strk = None
    lw = 1.0
    ctm = (1, 0, 0, 1, 0, 0)
    for o in ops:
        op = str(o.operator)
        a = o.operands
        try:
            if op == "q":
                stack.append((strk, lw, ctm))
            elif op == "Q":
                if stack:
                    strk, lw, ctm = stack.pop()
            elif op == "cm":
                m = tuple(float(x) for x in a)
                A, B, C, D, E, F = ctm
                ctm = (m[0]*A + m[1]*C, m[0]*B + m[1]*D,
                       m[2]*A + m[3]*C, m[2]*B + m[3]*D,
                       m[4]*A + m[5]*C + E, m[4]*B + m[5]*D + F)
            elif op == "CS":
                strk = _csname(res, str(a[0]))
            elif op in ("K", "RG", "G"):
                strk = "@device"
            elif op == "w":
                lw = float(a[0])
        except Exception:
            pass

        if op in PAINT:
            import math as _m
            sc = _m.sqrt(abs(ctm[0]*ctm[3] - ctm[1]*ctm[2])) or 1.0
            keep = (op in (PAINT_STROKE | PAINT_BOTH)
                    and strk is not None and strk.startswith("@")
                    and 0 < lw * sc <= 2.0)
            if not keep:
                out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("n")))
                continue
            if op in PAINT_BOTH:
                out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("S")))
                continue
        if op in SHOW_TEXT:
            continue
        out.append(o)

    data = unparse_content_stream(out)
    if "/Contents" in obj:
        obj.Contents = pdf.make_stream(data)
    else:
        obj.write(data)

    xo = res.get("/XObject") if res is not None else None
    if xo is None:
        return
    for k in xo.keys():
        try:
            x = xo[k]
        except Exception:
            continue
        if x.get("/Subtype") != Name("/Form"):
            continue
        oid = x.objgen
        if oid in seen:
            continue
        seen.add(oid)
        _filter_knockout(pdf, x, x.get("/Resources", res), seen)


def isolate_knockout_pdf(src, page_index, out_path):
    pdf = pikepdf.Pdf.open(src)
    new = pikepdf.Pdf.new()
    new.pages.append(pdf.pages[page_index])
    pg = new.pages[0]
    _filter_knockout(new, pg, pg.get("/Resources", Dictionary()), set())
    new.save(out_path)
    return out_path


def isolate_pdf(src, page_index, colorant, out_path):
    """One-page PDF containing only the geometry painted in `colorant`."""
    pdf = pikepdf.Pdf.open(src)
    new = pikepdf.Pdf.new()
    new.pages.append(pdf.pages[page_index])
    pg = new.pages[0]
    _filter_stream(new, pg, pg.get("/Resources", Dictionary()), colorant, set())
    new.save(out_path)
    return out_path


FILLRE = re.compile(r'fill="(#[0-9a-fA-F]{6})"')
STROKERE = re.compile(r'stroke="(#[0-9a-fA-F]{6})"')


def _lum(hexcol):
    r = int(hexcol[1:3], 16) / 255
    g = int(hexcol[3:5], 16) / 255
    b = int(hexcol[5:7], 16) / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ink_colour(svg, fallback):
    """mutool renders a separation in its real alternate colour, which beats
    guessing from the swatch name. White is the exception - it needs a visible
    stand-in on a light ground."""
    from collections import Counter
    cols = Counter(FILLRE.findall(svg) + STROKERE.findall(svg))
    if not cols:
        return fallback
    top = cols.most_common(1)[0][0].lower()
    if _lum(top) > 0.86:
        return "#96a0a6"
    return top


BARE_AMP = re.compile(r'&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)')


def sanitise(svg):
    """mutool copies Illustrator layer names straight into data-name attributes,
    and every one of these files has a layer called `Reg Marks & Info`. A bare
    ampersand makes the document invalid XML, and an SVG inside <img> is parsed
    strictly - so the browser silently renders nothing. Escape them."""
    return BARE_AMP.sub("&amp;", svg)


def is_well_formed(svg):
    import xml.etree.ElementTree as ET
    try:
        ET.fromstring(svg)
        return True
    except Exception:
        return False


SVG_OPEN = re.compile(r'<svg\b[^>]*>', re.S)
# MuPDF 1.23 writes width="1152pt"; 1.25 writes width="1152". Match the number
# and let the unit be anything or nothing - and never re-emit a unit we did not
# read, because "1152" and "1152pt" are not the same size (1pt = 1.333px).
SVGLEN = r'[\d.]+\s*(?:pt|px|mm|cm|in|pc|em|ex|%)?'
WH = re.compile(rf'width="({SVGLEN})"\s+height="({SVGLEN})"\s+viewBox="([^"]+)"')
VIEWBOX = re.compile(r'viewBox="\s*([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)\s*"')


class ChokeCompositionError(RuntimeError):
    """The choke mask could not be built for this plate.

    Raised rather than returning the plate unmasked. An un-choked plate is
    indistinguishable by eye from a correctly choked one - that is the whole
    reason the masking code exists - so a silent fallback produces a plausible
    and wrong preview. Fail loudly and let the caller record it.
    """
ID_DEF = re.compile(r'\bid="([^"]+)"')
ID_REF = re.compile(r'(url\(#|xlink:href="#|href="#)([^)"]+)')


def _inner(svg):
    m = SVG_OPEN.search(svg)
    if not m:
        return svg
    end = svg.rfind("</svg>")
    return svg[m.end():end if end != -1 else len(svg)]


def _prefix_ids(svg, pre):
    svg = ID_DEF.sub(lambda m: f'id="{pre}{m.group(1)}"', svg)
    svg = ID_REF.sub(lambda m: f'{m.group(1)}{pre}{m.group(2)}', svg)
    return svg


def compose_knockout(plate_svg_text, knockout_svg_text):
    """Carve the knockout strokes out of a plate.

    A choke is not geometry that was removed - it is a zero-ink stroke painted
    across the edge with overprint off, which writes 0% to the spot plate. The
    colorant filter cannot see it, because it is painted in DeviceCMYK, so an
    isolated underbase comes out at its full un-choked size. Masking the plate
    with those strokes reproduces what the RIP actually puts on the screen.
    """
    # Reuse the plate's own <svg> open tag verbatim. The mask only needs the
    # viewBox; echoing width/height through a format string is what let a
    # renderer's change of spelling turn into a silent unit conversion.
    open_tag = SVG_OPEN.search(plate_svg_text)
    vb = VIEWBOX.search(plate_svg_text)
    if not open_tag or not vb:
        raise ChokeCompositionError(
            "plate SVG has no parseable <svg> open tag with a viewBox; "
            f"header was: {plate_svg_text[:200]!r}")
    x0, y0, vw, vh = vb.group(1), vb.group(2), vb.group(3), vb.group(4)
    ko = _prefix_ids(_inner(knockout_svg_text), "ko_")
    ko = ko.replace('stroke="#ffffff"', 'stroke="#000000"')
    ko = re.sub(r'stroke="#[0-9a-fA-F]{6}"', 'stroke="#000000"', ko)
    body = _inner(plate_svg_text)
    return (f'{open_tag.group(0)}\n'
            f'<defs><mask id="choke" maskUnits="userSpaceOnUse" '
            f'x="{x0}" y="{y0}" width="{vw}" height="{vh}">\n'
            f'<rect x="{x0}" y="{y0}" width="{vw}" height="{vh}" fill="#ffffff"/>\n'
            f'{ko}\n</mask></defs>\n'
            f'<g mask="url(#choke)">{body}</g>\n</svg>\n')


def knockout_svg(src, page_index, max_bytes=None):
    """SVG of just the zero-ink knockout strokes on this artboard, or None."""
    max_bytes = CFG.SVG_MAX_BYTES if max_bytes is None else max_bytes
    tmp = tempfile.mkdtemp(prefix="ps_ko_")
    try:
        pdf_path = os.path.join(tmp, "ko.pdf")
        isolate_knockout_pdf(src, page_index, pdf_path)
        subprocess.run([CFG.MUTOOL_BIN, "draw", "-F", "svg", "-O", "text=path",
                        "-o", os.path.join(tmp, "ko.svg"), pdf_path, "1"],
                       check=True, capture_output=True, timeout=180)
        import glob as _g
        hits = _g.glob(os.path.join(tmp, "ko*.svg"))
        if not hits or os.path.getsize(hits[0]) > max_bytes:
            return None
        text = sanitise(open(hits[0]).read())
        if "stroke=" not in text or not is_well_formed(text):
            return None
        return text
    except Exception:
        return None
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def recolour(svg, hexcol):
    """One plate, one ink, one colour."""
    svg = FILLRE.sub(f'fill="{hexcol}"', svg)
    svg = STROKERE.sub(f'stroke="{hexcol}"', svg)
    return svg


def plate_svg(src, page_index, colorant, max_bytes=None):
    """SVG string for one plate, or None if it comes out unreasonably large."""
    max_bytes = CFG.SVG_MAX_BYTES if max_bytes is None else max_bytes
    tmp = tempfile.mkdtemp(prefix="ps_vec_")
    try:
        pdf_path = os.path.join(tmp, "iso.pdf")
        isolate_pdf(src, page_index, colorant, pdf_path)
        # mutool appends the page number to the stem: iso.svg -> iso1.svg
        subprocess.run([CFG.MUTOOL_BIN, "draw", "-F", "svg", "-O", "text=path",
                        "-o", os.path.join(tmp, "iso.svg"), pdf_path, "1"],
                       check=True, capture_output=True, timeout=180)
        import glob as _g
        hits = _g.glob(os.path.join(tmp, "iso*.svg"))
        if not hits:
            return None, -1
        svg_path = hits[0]
        size = os.path.getsize(svg_path)
        if size > max_bytes:
            return None, size
        with open(svg_path) as fh:
            svg = sanitise(fh.read())
        if not is_well_formed(svg):
            return None, size          # fall back to raster rather than ship a blank
        return svg, size
    except Exception:
        return None, -1
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
