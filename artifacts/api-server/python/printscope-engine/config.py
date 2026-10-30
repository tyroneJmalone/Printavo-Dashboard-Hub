"""Paths and tunables, all overridable by environment variable.

Nothing else in the engine should hardcode a path. On Replit set these in
Secrets or a .env; locally the defaults resolve next to this file.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def _p(env, default):
    return os.environ.get(env, default)


# The rule table. This is the product - see README.
RULES_CSV = _p("PRINTSCOPE_RULES", os.path.join(HERE, "printscope-rules-v2.csv"))

# Where inspection results are written, one JSON per file.
QUEUE_DIR = _p("PRINTSCOPE_QUEUE", os.path.join(HERE, "queue"))

# Where the viewer and its plate files are built.
SITE_DIR = _p("PRINTSCOPE_SITE", os.path.join(HERE, "site"))

# External binaries. Both must be on PATH or given absolutely.
GS_BIN = _p("PRINTSCOPE_GS", "gs")
MUTOOL_BIN = _p("PRINTSCOPE_MUTOOL", "mutool")

# Raster resolution for the measurements that need pixels. 200 dpi is what the
# trap thresholds in the rule table were calibrated at - changing it moves the
# numbers, so recalibrate if you do.
MEASURE_DPI = int(_p("PRINTSCOPE_MEASURE_DPI", "200"))

# Resolution for the raster fallback used when a plate is too dense for vector.
FALLBACK_DPI = int(_p("PRINTSCOPE_FALLBACK_DPI", "600"))

# A plate whose SVG exceeds this falls back to raster.
SVG_MAX_BYTES = int(_p("PRINTSCOPE_SVG_MAX_BYTES", "2500000"))

# Cross-cutting measurement constant, not a rule threshold: the share of a
# colour's area that must sit on the underbase before it counts as "based".
# Several rules consume the result, so it lives here rather than in any one
# rule's row. The base is dilated slightly first, so a plate nudged out of
# register still reads as based - which is what lets the register rule catch it.
BASED_INK_PCT = float(_p("PRINTSCOPE_BASED_INK_PCT", "85"))

# Engine version. Stamp it on every result so an old verdict can be read in
# terms of the code that produced it.
ENGINE_VERSION = _p("PRINTSCOPE_ENGINE_VERSION", "0.5.0")
