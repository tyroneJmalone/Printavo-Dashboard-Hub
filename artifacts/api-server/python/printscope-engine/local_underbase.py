"""Localized unsupported artwork, measured in physical points, not whole-ink %.

No inferred text/object identity. Regions are raster components, not Illustrator
objects. The edge allowance is 0.75pt plus one measurement pixel.
"""
import numpy as np
from scipy import ndimage as ndi

VERSION = 1
EDGE_PT = 0.75


def measure(colour, base, dpi=200):
    if colour.shape != base.shape:
        raise ValueError("Colour and underbase dimensions differ")
    scale = dpi / 72
    tolerance = EDGE_PT * scale + 1
    distance = ndi.distance_transform_edt(~np.pad(base, 1))[1:-1, 1:-1]
    if not base.any():
        distance[:] = np.inf
    missing = colour & (distance > tolerance)
    # A full artwork component with a missing base can be narrow (small type).
    labels, _ = ndi.label(colour)
    sizes = np.bincount(labels.ravel())
    missing_sizes = np.bincount(labels[missing], minlength=len(sizes))
    ratios = missing_sizes / np.maximum(sizes, 1)
    interior = ndi.distance_transform_edt(np.pad(colour, 1))[1:-1, 1:-1] > tolerance
    gaps, _ = ndi.label(missing)
    regions = []
    h, w = colour.shape
    for n, sl in enumerate(ndi.find_objects(gaps), 1):
        if sl is None:
            continue
        patch = gaps[sl] == n
        area = int(patch.sum())
        if area < 4:  # isolated raster specks, not a region-level judgement
            continue
        ids = labels[sl][patch]
        mostly_missing = bool(np.any(ratios[ids] >= .5))
        core = int((patch & interior[sl]).sum())
        if not mostly_missing and core == 0:
            continue  # edge-only raster/stroke differences, not missing artwork
        if area / scale**2 < 2:
            continue
        clear = area / scale**2 >= 4 and (mostly_missing or core / scale**2 >= 2)
        ys, xs = sl
        regions.append({
            "status": "fail" if clear else "flag",
            "areaPt2": round(area / scale**2, 3),
            "bbox": [xs.start / w, ys.start / h,
                     (xs.stop-xs.start) / w, (ys.stop-ys.start) / h],
        })
    return regions


def inspect(src, facts, raster):
    unders = [p for p in facts["artboards"] if p["is_underbase"]]
    colours = [p for p in facts["artboards"] if not p["is_underbase"] and p["inks"]]
    result = {"version": VERSION, "regions": [], "notes": [], "edgeAllowancePt": EDGE_PT,
              "dpi": raster.DPI, "minimumRegionAreaPt2": 2, "failureAreaPt2": 4,
              "rasterAllowancePx": 1, "error": None}
    if not unders or not colours:
        result["applicable"] = False
        return result
    result["applicable"] = True
    try:
        if len(unders) != 1:
            raise ValueError("Multiple underbase artboards require explicit pairing")
        under = raster.plates(src, unders[0]["index"])
        base = None
        for ink, mask in under.items():
            if ink in unders[0]["inks"]:
                base = mask.copy() if base is None else base | mask
        if base is None:
            raise ValueError("Underbase separation could not be rendered")
        for page in colours:
            plates = raster.plates(src, page["index"])
            cut = raster.info_bar_cut(plates, raster.text_rows_for(page), raster.DPI)
            if cut is None:
                raise ValueError("Could not exclude the information strip from localized coverage")
            b = base.copy()
            b[:cut+1] = False
            for ink in page["inks"]:
                if ink == "All":
                    continue
                if ink not in plates:
                    raise ValueError("A declared colour separation could not be rendered")
                colour = plates[ink].copy()
                if colour.shape != b.shape:
                    raise ValueError("Colour and underbase artboards differ in size")
                colour[:cut+1] = False
                total = int(colour.sum())
                if not total:
                    continue
                overlap = int((colour & b).sum()) / total
                if overlap <= .15:
                    result["notes"].append(f"{ink}: low/no base overlap; base intent is not inferred.")
                    # A wholly unbased colour is not a localized omission.
                    continue
                for region in measure(colour, b, raster.DPI):
                    result["regions"].append({**region, "ink": ink, "artboard": page["index"]})
        # Bound result size, but never silently discard a defect verdict.
        result["failCount"] = sum(r["status"] == "fail" for r in result["regions"])
        result["flagCount"] = sum(r["status"] == "flag" for r in result["regions"])
        result["omittedRegions"] = max(0, len(result["regions"]) - 500)
        result["regions"] = sorted(result["regions"], key=lambda r: (r["status"] != "fail", -r["areaPt2"]))[:500]
    except Exception as exc:
        result["error"] = str(exc)
    return result
