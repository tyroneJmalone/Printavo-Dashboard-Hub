"""Additional PDF facts, independent of rule policy.

Unsupported colour transforms and font encodings remain explicitly unknown;
they must not turn a missing measurement into a clean inspection.
"""
import math
import re

from pikepdf import Array, Dictionary


def resolve_space(space, resources, depth=0):
    if depth > 8:
        return None
    if isinstance(space, Array):
        return space
    name = str(space)
    if name in ("/DeviceRGB", "/DeviceCMYK", "/DeviceGray",
                "/RGB", "/CMYK", "/G"):
        return space
    spaces = resources.get("/ColorSpace", {}) if resources is not None else {}
    if name in spaces:
        return resolve_space(spaces[name], resources, depth + 1)
    return space


def space_family(space, resources, depth=0):
    if depth > 8:
        return "unknown"
    space = resolve_space(space, resources)
    if isinstance(space, Array):
        kind = str(space[0])[1:]
        if kind == "Indexed":
            return space_family(space[1], resources, depth + 1)
        if kind == "ICCBased":
            return {1: "DeviceGray", 3: "DeviceRGB", 4: "DeviceCMYK"}.get(
                int(space[1].get("/N", 0)), "unknown")
        return kind
    return {"/RGB": "DeviceRGB", "/CMYK": "DeviceCMYK", "/G": "DeviceGray"}.get(
        str(space), str(space).lstrip("/") if space is not None else "unknown")


def full_tint(space, resources):
    """Record /C1 and its alternate space. Only supported conversions get RGB."""
    alternate, transform = resolve_space(space[2], resources), space[3]
    kind = str(alternate[0]) if isinstance(alternate, Array) else str(alternate)
    rec = {"alternate": kind.lstrip("/"), "c1": None, "rgb": None}
    if int(transform.get("/FunctionType", -1)) != 2:
        rec["error"] = "unsupported tint transform (requires FunctionType 2 /C1)"
        return rec
    values = transform.get("/C1")
    if values is None:
        rec["error"] = "tint transform has no /C1"
        return rec
    c = [float(x) for x in values]
    rec["c1"] = c
    # ICC profile conversion and CalRGB/Lab require profile/white-point handling;
    # guessing sRGB for those would manufacture a corroboration.
    if kind == "/DeviceRGB" and len(c) == 3:
        rgb = c
    elif kind == "/DeviceGray" and len(c) == 1:
        rgb = c * 3
    elif kind == "/DeviceCMYK" and len(c) == 4:
        rgb = [1 - min(1, x + c[3]) for x in c[:3]]
    else:
        rec["error"] = "unsupported alternate colour space: " + kind
        return rec
    rec["rgb"] = [round(max(0, min(1, x)) * 255) for x in rgb]
    return rec


def colorant_details(page):
    found, seen = [], set()

    def walk(resources, depth=0):
        if resources is None or depth > 12:
            return
        for space in resources.get("/ColorSpace", {}).values():
            if isinstance(space, Array) and str(space[0]) == "/Separation":
                name = str(space[1])[1:]
                try:
                    rec = dict(name=name, **full_tint(space, resources))
                except Exception as exc:
                    rec = {"name": name, "rgb": None, "error": str(exc)}
                if rec not in found:
                    found.append(rec)
        for obj in resources.get("/XObject", {}).values():
            if str(obj.get("/Subtype")) == "/Form" and obj.objgen not in seen:
                seen.add(obj.objgen)
                walk(obj.get("/Resources", resources), depth + 1)

    walk(page.get("/Resources"))
    return found


def image_placement(image, matrix, resources, layer, name):
    width, height = int(image.get("/Width", 0)), int(image.get("/Height", 0))
    x_pt, y_pt = math.hypot(*matrix[:2]), math.hypot(*matrix[2:4])
    dpi_x = width * 72 / x_pt if x_pt and width else None
    dpi_y = height * 72 / y_pt if y_pt and height else None
    return {
        "name": name, "layer": str(layer), "width_px": width, "height_px": height,
        "ctm": list(matrix), "placed_width_pt": x_pt, "placed_height_pt": y_pt,
        "dpi_x": dpi_x, "dpi_y": dpi_y,
        "effective_dpi": min(dpi_x, dpi_y) if dpi_x and dpi_y else None,
        "colorspace": space_family(image.get("/ColorSpace"), resources),
        "is_mask": bool(image.get("/ImageMask", False)),
    }


def _unicode(hex_string):
    return bytes.fromhex(hex_string).decode("utf-16-be")


def unicode_map(font):
    cmap = font.get("/ToUnicode")
    if cmap is None:
        return None
    text = cmap.read_bytes().decode("latin-1")
    result = {}
    for block in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
        for src, dst in re.findall(r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>", block):
            result[bytes.fromhex(src)] = _unicode(dst)
    for block in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
        for lo, hi, target in re.findall(
                r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^]]*\]|<[0-9a-fA-F]+>)",
                block, re.S):
            start, end = int(lo, 16), int(hi, 16)
            if end - start > 65535:
                raise ValueError("oversized ToUnicode range")
            if target.startswith("["):
                values = re.findall(r"<([0-9a-fA-F]+)>", target)
            else:
                base = target[1:-1]
                values = [f"{int(base, 16) + i:0{len(base)}x}" for i in range(end - start + 1)]
            for i, value in enumerate(values[:end - start + 1]):
                result[(start + i).to_bytes(len(lo) // 2, "big")] = _unicode(value)
    return result


def decode_text(operands, operator, font):
    values = operands[0] if operator == "TJ" else [operands[-1]]
    if font is None:
        return None, "text font unavailable"
    try:
        mapping = unicode_map(font)
        encoding = font.get("/Encoding")
        if mapping is None:
            if str(font.get("/Subtype")) == "/Type0":
                return None, "composite font without ToUnicode"
            # Do not treat custom Differences as Latin-1: that can silently
            # rename an ink. ToUnicode is authoritative for embedded fonts.
            if isinstance(encoding, Dictionary):
                return None, "custom font encoding without ToUnicode"
            codec = {"/WinAnsiEncoding": "cp1252", "/MacRomanEncoding": "mac_roman",
                     "/StandardEncoding": "ascii", "None": "ascii"}.get(str(encoding))
            if codec is None:
                return None, "unsupported font encoding"
        out = []
        for value in values:
            if isinstance(value, (int, float)) or type(value).__name__ == "Decimal":
                continue
            raw = bytes(value)
            if mapping is None:
                out.append(raw.decode(codec))
                continue
            widths = sorted({len(key) for key in mapping}, reverse=True)
            pos = 0
            while pos < len(raw):
                key = next((raw[pos:pos + n] for n in widths
                            if raw[pos:pos + n] in mapping), None)
                if key is None:
                    return None, "unmapped ToUnicode glyph"
                out.append(mapping[key])
                pos += len(key)
        return "".join(out), None
    except Exception as exc:
        return None, "text decode failed: " + str(exc)