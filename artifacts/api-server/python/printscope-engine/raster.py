"""Raster metrics: per-separation plates via Ghostscript tiffsep, plus the
perimeter-adjacency measurement that drives the trap rule."""
import glob, os, shutil, subprocess, tempfile
from itertools import combinations
import numpy as np
from PIL import Image
from scipy import ndimage

import config as CFG
from ink_names import ink_key

DPI = CFG.MEASURE_DPI
WHITE_RE = ("white",)


def _sepname(path):
    b = os.path.basename(path)[:-4]
    if b.startswith("p(") and b.endswith(")"):
        return b[2:-1]
    if b.startswith("p("):
        return b[2:]
    return b


def plates(src, page, dpi=DPI):
    """Render one artboard to per-separation masks. Returns {ink: bool ndarray}."""
    tmp = tempfile.mkdtemp(prefix="ps_plate_")
    try:
        subprocess.run(
            [CFG.GS_BIN, "-q", "-dBATCH", "-dNOPAUSE", "-dSAFER", "-sDEVICE=tiffsep",
             f"-r{dpi}", f"-dFirstPage={page}", f"-dLastPage={page}",
             "-sOutputFile=" + os.path.join(tmp, "p.tif"), src],
            check=True, capture_output=True, timeout=300)
        out = {}
        for f in sorted(glob.glob(os.path.join(tmp, "*.tif"))):
            if os.path.basename(f) == "p.tif":
                continue
            nm = _sepname(f)
            arr = np.array(Image.open(f).convert("L"))
            mask = arr < 200
            if mask.sum() > 0:
                out[nm] = mask
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def is_white_ink(name):
    n = name.lower()
    return any(w in n for w in WHITE_RE)


def ink_overlaps(src, page, names, dpi=DPI):
    """Pairwise overlap width in points at the calibrated measurement DPI.

    Limit to named painted inks: tiffsep also produces process/registration
    furniture channels. Never compare a base against its intended top colour.
    Padding provides a real zero boundary even when a mask fills the raster.
    """
    ps = plates(src, page, dpi)
    names = sorted(n for n in set(names) - {"All"} if "under" not in (ink_key(n) or ""))
    missing = [name for name in names if name not in ps]
    if missing:
        raise ValueError("raster plates unavailable: " + ", ".join(missing))
    out = []
    for a, b in combinations(names, 2):
        overlap = ps[a] & ps[b]
        count = int(overlap.sum())
        width = (2 * float(ndimage.distance_transform_edt(
            np.pad(overlap, 1)).max()) * 72 / dpi) if count else 0.0
        out.append({"artboard": page, "inks": [a, b],
                    "max_width_pt": round(width, 4), "overlap_px": count, "dpi": dpi})
    return out


def perimeter_adjacency(src, page, dpi=DPI):
    """For each colorant on this artboard, what share of its perimeter is
    adjacent to another ink. High = bounded by other ink, no trap needed."""
    ps = plates(src, page, dpi)
    inks = {k: v for k, v in ps.items()
            if k not in ("Cyan", "Magenta", "Yellow", "Black", "All")}
    if not inks:
        inks = {k: v for k, v in ps.items() if k != "All"}
    res = {}
    k3 = np.ones((3, 3), bool)
    k5 = np.ones((5, 5), bool)
    for name, m in inks.items():
        if m.sum() < 50:
            continue
        per = m & ~ndimage.binary_erosion(m, k3)
        others = np.zeros_like(m)
        for k2, v2 in inks.items():
            if k2 != name:
                others |= v2
        near = ndimage.binary_dilation(others, k5)
        touch = int((per & near).sum())
        total = int(per.sum())
        res[name] = {
            "perimeter_px": total,
            "abutting_px": touch,
            "abutting_pct": round(100.0 * touch / max(total, 1), 1),
            "free_edge_px": total - touch,
            "is_white": is_white_ink(name),
        }
    return res


def erosion_topology(src, page, choke_pt=0.375, dpi=DPI, only=None):
    """Does a choke fragment the base? Predicts choke-vs-spread technique."""
    ps = plates(src, page, dpi)
    m = np.zeros((1, 1), bool)
    for k, v in ps.items():
        if k in ("Cyan", "Magenta", "Yellow", "Black", "All"):
            continue
        if only is not None and k not in only:
            continue
        m = v if m.shape == (1, 1) else (m | v)
    if m.sum() == 0:
        return None
    px = max(int(round(choke_pt / 72.0 * dpi)), 1)
    k = np.ones((2 * px + 1, 2 * px + 1), bool)
    before = ndimage.label(m)[1]
    eroded = ndimage.binary_erosion(m, k)
    after = ndimage.label(eroded)[1]
    lbl, n = ndimage.label(m)
    vanished = 0
    if n:
        keep = set(np.unique(lbl[eroded]))
        vanished = sum(1 for i in range(1, n + 1) if i not in keep)
    return {"components_before": int(before), "components_after": int(after),
            "vanished": int(vanished), "choke_px": px}


def base_coverage(src, colour_page, under_page, dpi=DPI):
    """What fraction of each colour ink's area sits on the underbase.

    Returns {ink: {pct, px}} plus the inks considered 'based', at or above
    CFG.BASED_INK_PCT.
    """
    cp = plates(src, colour_page, dpi)
    up = plates(src, under_page, dpi)
    base = None
    for k, vmask in up.items():
        if k in ("Cyan", "Magenta", "Yellow", "Black", "All"):
            continue
        base = vmask if base is None else (base | vmask)
    if base is None:
        return {}, []
    # dilate the base a little: a based ink stays based even when the plate is
    # nudged out of register, which is the defect we still want to catch later
    base_t = ndimage.binary_dilation(base, np.ones((9, 9), bool))
    cov = {}
    for k, m in cp.items():
        if k in ("Cyan", "Magenta", "Yellow", "Black", "All") or m.sum() < 50:
            continue
        if m.shape != base_t.shape:
            continue
        inside = int((m & base_t).sum())
        tot = int(m.sum())
        cov[k] = {"px": tot, "on_base_px": inside,
                  "pct": round(100.0 * inside / max(tot, 1), 1)}
    based = [k for k, d in cov.items() if d["pct"] >= CFG.BASED_INK_PCT]
    return cov, based
