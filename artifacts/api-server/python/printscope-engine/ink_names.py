"""Swatch identity parsing shared by fact consumers."""
import re


def swatch_parts(name):
    normalized = re.sub(r"\s*-+\s*", "-", name.strip())
    match = re.match(
        r"^(\d+(?:-\d+)?(?:\s*&\s*\d+(?:-\d+)?)?)(?:-|\s+)(.+)$",
        normalized)
    return (match[1], match[2].strip()) if match else (None, None)


def ink_key(name):
    _, ink = swatch_parts(name)
    return re.sub(r"\s+", " ", re.sub(r"\s*&\s*", "&", ink)).casefold() if ink else None