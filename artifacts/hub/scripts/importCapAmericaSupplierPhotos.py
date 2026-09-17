#!/usr/bin/env python3
"""Import verified Cap America supplier photos for the three 2026 samples.

The product markdown files are deliberately inputs rather than checked-in
fixtures.  They contain the supplier's observed, color-labelled Thumbnail
URLs.  For each exact catalog color this script derives the same filename in
the larger supplier image collections, validates the response as an image, and
stores a local JPEG plus provenance metadata.

Example:
  python3 importCapAmericaSupplierPhotos.py \
    /tmp/cap-supplier-i8501.md /tmp/cap-supplier-i8530.md \
    /tmp/cap-supplier-i8503.md
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "public" / "cap-america-2026" / "supplier"
DEFAULT_SOURCE = ROOT / "src" / "data" / "capAmericaSamples.ts"
STYLES = ("i8501", "i8530", "i8503")
USER_AGENT = "PrintavoHub-CapAmericaSupplierImporter/1.0"
TIMEOUT = 20
MAX_WORKERS = 6


def parse_catalog_colors(source_path: Path) -> dict[str, list[str]]:
    """Read the canonical color spelling directly from capAmericaSamples.ts."""
    source = source_path.read_text(encoding="utf-8")
    result: dict[str, list[str]] = {}
    for style in STYLES:
        match = re.search(
            rf'style:\s*"{re.escape(style)}".*?'
            rf'colors:\s*colors\("{re.escape(style)}",\s*\[(.*?)\]\),',
            source,
            re.DOTALL,
        )
        if not match:
            raise ValueError(f"Could not read canonical colors for {style} from {source_path}")
        result[style] = re.findall(r'"([^"]+)"', match.group(1))
    return result


def parse_markdown(markdown_path: Path, style: str) -> dict[str, str]:
    """Return observed Thumbnail URL by its immediately following supplier label."""
    text = markdown_path.read_text(encoding="utf-8")
    rows = re.findall(
        r'!\[\]\((https?[^)\s]+/Products/Thumbnail/[^)\s]+)\)([^\r\n]*)',
        text,
    )
    observed: dict[str, str] = {}
    for url, raw_label in rows:
        label = raw_label.strip()
        if label and label not in observed:
            observed[label] = url
    if not observed:
        raise ValueError(f"No labelled Thumbnail URLs found in {markdown_path}")
    return observed


def larger_urls(thumbnail_url: str) -> list[str]:
    """Try the supplier's named larger collections, keeping the observed filename."""
    return [
        thumbnail_url.replace("/Thumbnail/", f"/{size}/")
        for size in ("Medium", "Large", "Original")
    ]


def fetch_first_valid(urls: list[str]) -> tuple[str | None, tuple[bytes, str, tuple[int, int]] | None]:
    for candidate in urls:
        fetched = fetch_image(candidate)
        if fetched:
            return candidate, fetched
    return None, None


def fetch_image(url: str) -> tuple[bytes, str, tuple[int, int]] | None:
    """Fetch and validate content, format, and useful dimensions."""
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            payload = response.read()
    except (HTTPError, URLError, TimeoutError, OSError):
        return None
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
        with Image.open(io.BytesIO(payload)) as image:
            dimensions = image.size
            image_format = image.format or ""
    except (OSError, ValueError):
        return None
    if dimensions[0] < 500 or dimensions[1] < 500:
        return None
    return payload, image_format, dimensions


def slug(label: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return value


def save_jpeg(payload: bytes, path: Path) -> tuple[int, int]:
    """Store valid supplier content as an accurately named JPEG asset."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(payload)) as image:
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            background = Image.new("RGB", image.size, "white")
            alpha = image.getchannel("A") if "A" in image.getbands() else None
            background.paste(image.convert("RGBA"), mask=alpha)
            image = background
        else:
            image = image.convert("RGB")
        image.save(path, format="JPEG", quality=93, optimize=True)
        return image.size


def make_contact_sheet(
    output_dir: Path, style: str, chosen: dict[str, dict[str, Any]]
) -> None:
    """Make a compact, labelled visual audit of every selected color image."""
    columns = 5
    card_width, image_height, label_height = 190, 170, 48
    rows = (len(chosen) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * card_width, rows * (image_height + label_height)), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, (label, item) in enumerate(chosen.items()):
        # imageUrl is rooted at /cap-america-2026/... under this artifact's public dir.
        image_path = ROOT / "public" / item["imageUrl"].lstrip("/")
        with Image.open(image_path) as source:
            preview = source.convert("RGB")
            preview.thumbnail((card_width - 12, image_height - 12))
            x = (index % columns) * card_width
            y = (index // columns) * (image_height + label_height)
            px = x + (card_width - preview.width) // 2
            py = y + (image_height - preview.height) // 2
            sheet.paste(preview, (px, py))
            draw.text((x + 5, y + image_height + 3), label, fill="black", font=font)
            draw.text(
                (x + 5, y + image_height + 19),
                f'{item["width"]}×{item["height"]}',
                fill="#555555",
                font=font,
            )
    sheet.save(output_dir / f"{style}-contact-sheet.jpg", format="JPEG", quality=90, optimize=True)


def import_style(
    style: str,
    markdown_path: Path,
    catalog_colors: list[str],
    output_dir: Path,
) -> tuple[dict[str, Any], list[str], list[str]]:
    observed = parse_markdown(markdown_path, style)
    exact = {color: observed[color] for color in catalog_colors if color in observed}
    unmatched = [color for color in catalog_colors if color not in observed]
    style_dir = output_dir / style
    colors_dir = style_dir / "colors"
    colors_dir.mkdir(parents=True, exist_ok=True)

    jobs: dict[str, tuple[str, list[str]]] = {
        color: (thumbnail, larger_urls(thumbnail)) for color, thumbnail in exact.items()
    }
    chosen: dict[str, dict[str, Any]] = {}
    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {
            pool.submit(fetch_first_valid, urls): color
            for color, (_, urls) in jobs.items()
        }
        for future in as_completed(futures):
            color = futures[future]
            try:
                source_url, fetched = future.result()
            except Exception as error:  # keep one bad supplier record from stopping all styles
                print(f"{style} {color}: failed ({error})", file=sys.stderr)
                source_url, fetched = None, None
            if not source_url or not fetched:
                failures.append(color)
                continue
            payload, _source_format, dimensions = fetched
            filename = f"{catalog_colors.index(color) + 1:02d}-{slug(color)}.jpg"
            image_path = colors_dir / filename
            width, height = save_jpeg(payload, image_path)
            chosen[color] = {
                "imageUrl": f"/cap-america-2026/supplier/{style}/colors/{filename}",
                "sourceUrl": source_url,
                "width": width,
                "height": height,
            }

    chosen = {color: chosen[color] for color in catalog_colors if color in chosen}
    if not chosen:
        raise RuntimeError(f"No validated supplier photos found for {style}")
    hero_label = next(iter(chosen))
    hero = dict(chosen[hero_label])
    hero["label"] = hero_label
    hero_path = style_dir / "hero.jpg"
    with Image.open(ROOT / "public" / hero["imageUrl"].lstrip("/")) as image:
        image.save(hero_path, format="JPEG", quality=93, optimize=True)
    hero["imageUrl"] = f"/cap-america-2026/supplier/{style}/hero.jpg"

    make_contact_sheet(output_dir, style, chosen)
    product = {
        "productUrl": f"https://www.capamerica.com/{style}",
        "hero": hero,
        "colors": chosen,
    }
    return product, unmatched, failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("markdown", nargs=3, type=Path, help="supplier markdown for i8501, i8530, i8503")
    parser.add_argument("--source-ts", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    by_style = {path.stem.rsplit("-", 1)[-1]: path for path in args.markdown}
    if set(by_style) != set(STYLES):
        parser.error("three markdown inputs must be named cap-supplier-i8501.md, i8530.md, and i8503.md")
    catalog = parse_catalog_colors(args.source_ts)
    metadata: dict[str, Any] = {}
    report: dict[str, Any] = {}
    for style in STYLES:
        product, unmatched, failures = import_style(style, by_style[style], catalog[style], args.output)
        metadata[style] = product
        report[style] = {
            "catalogCount": len(catalog[style]),
            "verifiedCount": len(product["colors"]),
            "unmatchedExactNames": unmatched,
            "failedValidation": failures,
        }
        print(
            f"{style}: verified {len(product['colors'])}/{len(catalog[style])} "
            f"(unmatched={len(unmatched)}, failed={len(failures)})"
        )
        if unmatched:
            print(f"  unmatched exact names: {', '.join(unmatched)}")
        if failures:
            print(f"  failed validation: {', '.join(failures)}")

    args.output.mkdir(parents=True, exist_ok=True)
    metadata_path = ROOT / "src" / "data" / "capAmericaSupplierPhotos.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    (args.output / "import-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {metadata_path}")
    print(f"Wrote contact sheets and assets under {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())