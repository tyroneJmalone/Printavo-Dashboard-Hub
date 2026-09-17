#!/usr/bin/env python3
"""Reproducibly extract the three Cap America 2026 sample pages.

Source:
  /tmp/cap2026.pdf (PDF pages 12, 13, and 15)
  /tmp/cap2026.txt (pdftotext output used to verify the labels and counts)

The catalog's printed pages are 10, 11, and 13 respectively.  The crop
coordinates below are expressed in the 838x1088 raster produced by
``pdftoppm -r 100`` and are scaled to the requested render DPI.  They were
visually checked against the rendered pages: each color crop contains the cap
and its shadow, but starts above the printed color label.  The hero crops
retain Cap America's photographed decorated sample, rather than presenting it
as an undecorated product.

By default assets are written to artifacts/hub/public/cap-america-2026.  The
optional --upload flag mirrors the generated files into the first
PUBLIC_OBJECT_SEARCH_PATHS object-storage prefix using the authenticated
sidecar-authenticated upload helper.  The application currently has no general
public-objects serving route mounted, so the dataset intentionally uses the
bundled /cap-america-2026/... paths; storage object names are printed for a
future /api/storage/public-objects/... mapping.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[3]
PDF = Path("/tmp/cap2026.pdf")
OUT = ROOT / "artifacts/hub/public/cap-america-2026"
BASE_W, BASE_H = 838, 1088
RENDER_DPI = 150

SIZES = [
    ("XS", "6½–6⅞"),
    ("S/M", "7–7⅜"),
    ("L/XL", "7⅜–7⅞"),
    ("XXL", "7⅞–8¼"),
]

STYLES = {
    "i8501": {
        "pdf_page": 12,
        "printed_page": 10,
        "hero": (390, 65, 778, 305),
        "columns": [132, 244, 355, 468, 580, 692],
        "crop_half_width": 49,
        "rows": [
            (395, 450),
            (500, 570),
            (620, 710),
            (740, 830),
            (900, 960),
        ],
        "colors": [
            "Athletic Gold/Black/White",
            "Athletic Gold/Navy/White",
            "Black/Red/White",
            "Black/Royal/White",
            "Columbia Blue/Navy/White",
            "Maroon/Black/White",
            "Navy/Red/White",
            "Orange/Black/White",
            "Vegas Gold/Black/White",
            "Vegas Gold/Navy/White",
            "White/Black/Black",
            "White/Navy/Navy",
            "White/Navy/Red",
            "White/Royal/Red",
            "Black/Graphite",
            "Black/White",
            "Dark Green/White",
            "Graphite/Black",
            "Graphite/White",
            "Kelly Green/White",
            "Maroon/Graphite",
            "Navy/White",
            "Purple/White",
            "Red/White",
            "Royal/White",
            "Black",
            "Navy",
            "Red",
            "Royal",
            "White",
        ],
    },
    "i8530": {
        "pdf_page": 13,
        "printed_page": 11,
        "hero": (400, 65, 752, 305),
        "columns": [112, 223, 334, 445, 557, 667],
        "crop_half_width": 49,
        "rows": [
            (395, 450),
            (505, 555),
            (620, 710),
            (780, 835),
        ],
        "colors": [
            "Black/Black/Silver",
            "White/Black/Black",
            "White/Maroon/Maroon",
            "White/Navy/Navy",
            "White/Orange/Black",
            "White/Red/Black",
            "White/Red/Navy",
            "White/Royal/Royal",
            "Black/Red",
            "Black/Royal",
            "Silver/Black",
            "Silver/Navy",
            "Silver/Purple",
            "Black",
            "Dark Green",
            "Graphite",
            "Navy",
            "Red",
            "Royal",
            "Silver",
            "White",
        ],
    },
    "i8503": {
        "pdf_page": 15,
        "printed_page": 13,
        "hero": (430, 65, 752, 305),
        # The green page rail begins near x=742 in the source raster; unlike
        # the other two pages, this seven-column swatch grid is tighter.
        "columns": [112, 207, 302, 397, 492, 587, 682],
        # Row one carries small NEW badges between adjacent swatches.  The
        # narrower first-row crop avoids bleeding a neighboring badge into
        # the Orange/Black/White and Silver/Silver/Black thumbnails.
        "crop_half_widths": [28, 35, 35, 35, 35, 35],
        "rows": [
            (400, 445),
            (510, 560),
            (610, 665),
            (725, 805),
            (825, 900),
            (925, 980),
        ],
        "colors": [
            "Navy/Columbia Blue",
            "White/Black",
            "Loden",
            "Silver",
            "Vegas Gold",
            "Orange/Black/White",
            "Silver/Silver/Black",
            "White/Black/Black",
            "White/Maroon/Maroon",
            "White/Navy/Navy",
            "White/Red/Navy",
            "White/Red/Royal",
            "Black/Athletic Gold",
            "Black/Orange",
            "Dark Green/Athletic Gold",
            "Navy/Athletic Gold",
            "Red/Black",
            "Red/Navy",
            "Royal/Red",
            "Silver/Black",
            "Silver/Navy",
            "Silver/Red",
            "Silver/Royal",
            "White/Navy",
            "White/Red",
            "White/Royal",
            "Black",
            "Brown",
            "Cardinal",
            "Columbia Blue",
            "Dark Green",
            "Graphite",
            "Kelly Green",
            "Maroon",
            "Navy",
            "Orange",
            "Purple",
            "Red",
            "Royal",
            "True Texas Orange",
            "White",
        ],
    },
}


def render_page(pdf_page: int, work_dir: Path) -> Path:
    prefix = work_dir / f"page-{pdf_page:03d}"
    subprocess.run(
        [
            "pdftoppm",
            "-f",
            str(pdf_page),
            "-l",
            str(pdf_page),
            "-r",
            str(RENDER_DPI),
            "-jpeg",
            "-jpegopt",
            "quality=92",
            str(PDF),
            str(prefix),
        ],
        check=True,
    )
    candidates = sorted(prefix.parent.glob(f"{prefix.name}-*.jpg"))
    if not candidates:
        raise FileNotFoundError(f"pdftoppm did not produce a JPEG for PDF page {pdf_page}")
    return candidates[0]


def scaled_box(box: tuple[int, int, int, int], image: Image.Image) -> tuple[int, int, int, int]:
    sx, sy = image.width / BASE_W, image.height / BASE_H
    return tuple(round(value * (sx if index % 2 == 0 else sy)) for index, value in enumerate(box))


def slug(value: str) -> str:
    return (
        value.lower()
        .replace("/", "-")
        .replace(" ", "-")
        .replace("½", "1-2")
        .replace("⅞", "7-8")
        .replace("⅜", "3-8")
        .replace("⅝", "5-8")
        .replace("⅞", "7-8")
    )


def crop_and_save(source: Image.Image, box: tuple[int, int, int, int], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    source.crop(scaled_box(box, source)).save(destination, "JPEG", quality=92, optimize=True)


def extract() -> list[Path]:
    if not PDF.exists():
        raise FileNotFoundError(f"Expected catalog source at {PDF}")
    OUT.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    with tempfile.TemporaryDirectory(prefix="cap-america-pages-") as temporary:
        rendered: dict[int, Image.Image] = {}
        for style, manifest in STYLES.items():
            if manifest["pdf_page"] not in rendered:
                rendered[manifest["pdf_page"]] = Image.open(
                    render_page(manifest["pdf_page"], Path(temporary))
                ).convert("RGB")
            page = rendered[manifest["pdf_page"]]
            style_dir = OUT / style
            style_dir.mkdir(parents=True, exist_ok=True)
            page_path = style_dir / f"page-{manifest['printed_page']}.jpg"
            page.save(page_path, "JPEG", quality=88, optimize=True)
            written.append(page_path)
            hero_path = style_dir / "hero.jpg"
            crop_and_save(page, manifest["hero"], hero_path)
            written.append(hero_path)

            color_index = 0
            for row_index, row_box in enumerate(manifest["rows"]):
                for center in manifest["columns"]:
                    if color_index >= len(manifest["colors"]):
                        break
                    color_name = manifest["colors"][color_index]
                    half_widths = manifest.get("crop_half_widths")
                    half_width = (
                        half_widths[row_index]
                        if half_widths
                        else manifest.get("crop_half_width", 49)
                    )
                    box = (center - half_width, row_box[0], center + half_width, row_box[1])
                    color_path = style_dir / "colors" / f"{color_index + 1:02d}-{slug(color_name)}.jpg"
                    crop_and_save(page, box, color_path)
                    written.append(color_path)
                    color_index += 1
            if color_index != len(manifest["colors"]):
                raise AssertionError(
                    f"{style}: crop manifest has {color_index} boxes for "
                    f"{len(manifest['colors'])} labels"
                )
    return written


def upload(paths: list[Path]) -> None:
    """Mirror assets to App Storage's public prefix without exposing credentials."""
    subprocess.run(
        [
            "node",
            str(Path(__file__).with_name("uploadCapAmericaSamples.mjs")),
            str(OUT),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upload", action="store_true", help="also mirror images into App Storage public prefix")
    args = parser.parse_args()
    paths = extract()
    print(f"Extracted {len(paths)} images to {OUT}")
    if args.upload:
        upload(paths)


if __name__ == "__main__":
    main()