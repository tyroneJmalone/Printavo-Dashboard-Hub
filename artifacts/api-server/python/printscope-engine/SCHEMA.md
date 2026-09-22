# The result contract

`run.py` writes one JSON per inspected file into `queue/`. **This object is the
product.** The viewer in `build_site.py` is one consumer of it; a React UI in the
Hub would be another, and the Printavo automation in Section I of the roadmap a
third. Rewrite the UI freely — but if you change this shape, change it
deliberately, because everything downstream branches on it.

## Top level

| Field | Type | Notes |
|---|---|---|
| `inspection_id` | uuid | unique per inspection run |
| `filename` | string | as received |
| `sha256_16` | string | first 16 hex of the file's SHA-256. **Verdicts are keyed on this, not on the filename** — a file in the corpus changed on disk between two inspections, and a vendor resending revised artwork under the original name must not overwrite the earlier verdict. The reference runner names results `<filename>__<sha10>.json` for that reason; a database should use the same identity |
| `bytes` | int | |
| `inspected_at` | ISO 8601 | local time, seconds precision |
| `engine_version` | string | the code that produced this |
| `rules_version` | string | fingerprint of the rule table used |
| `verdict` | `"pass" \| "flag" \| "fail"` | what the rules **found**: any fail → fail; else any flag → flag; else pass |
| `completeness` | object | whether enough rules ran to trust that verdict |
| `results` | array | one entry per rule that ran, in `sort_order` |
| `previews` | array | one entry per artboard |
| `adjacency` | object | per-colorant perimeter measurements, the input to the trap rule |
| `ctx` | object | derived measurements the detectors consumed |
| `facts` | object | the full extraction. Large. Useful for debugging, not for the UI |

## `results[]`

```json
{
  "code": "ART_PRESENT",
  "name": "Artboard contains artwork",
  "severity": "fail",
  "status": "pass",
  "headline": "46 objects across 1 artboard(s)",
  "detail": ["free-form lines shown under the headline"],
  "data": {},
  "remediation": "This artboard has no artwork on it at all. Send back to seps.io.",
  "sort_order": 30
}
```

**`severity` and `status` are different things and the distinction matters.**

- `severity` is what the rule table says this rule is worth: `fail`, `flag` or
  `info`. It comes from the CSV, never from code.
- `status` is what happened to this rule on this file.

A detector returns `fail` when its own condition is violated. `evaluate()` then
demotes that to the table's severity — so a detector that returns `fail` on a
rule marked `flag` produces `status: "flag"`. This is why changing a rule from
red to yellow is a spreadsheet edit. **Demotion applies to judgements only:** a
rule that could not run is not made quieter by the table calling it a flag.

### The eight statuses

Four are judgements — the rule ran and reached a conclusion:

| `pass` | `flag` | `fail` | `info` |
|---|---|---|---|

Four are not, and **collapsing them into one bucket is the single easiest way
to make this system lie**:

| Status | Means | Counts against completeness? |
|---|---|---|
| `not_applicable` | Genuinely nothing to check. No underbase on the file, no white ink, only white on the colour board. | No |
| `cannot_evaluate` | The rule applies and could not run. Gradients the parser cannot attribute, a measurement that failed. **Not a pass — this check did not happen.** | **Yes** |
| `not_implemented` | The rule is in the table and no detector exists yet. Reported rather than omitted, because silence about a rule reads as though it passed. | No, but always shown |
| `error` | The detector raised. | **Yes** |

`data` carries whatever the rule measured, keyed per rule — `{"max_pt": 1.0}`
for the register check, `{"empty": [...]}` for unused plates. Read it when you
need the number; don't parse `headline`.

## `completeness`

```json
{
  "complete": false,
  "judged": 22,
  "not_applicable": 1,
  "cannot_evaluate": 2,
  "not_implemented": 12,
  "errors": 0,
  "unverified": ["ARTWORK_IN_REGISTER: gradient blend present - plates deliberately do not align"]
}
```

`verdict` answers *what did the rules find*. `completeness` answers *did enough
of them run to trust that*. They are deliberately separate fields, because a
file where two checks could not run and none of the rest failed would otherwise
render as a clean pass.

**`complete: false` must be surfaced wherever a verdict is surfaced.** In the
UI that is a strip under the banner. In the automation of Section I it is a
hard gate: an incomplete inspection is never eligible for an automated pass, no
matter what `verdict` says.

`not_implemented` does not set `complete: false` — it is a known, permanent
state of the rule table rather than something that went wrong on this file —
but the count is always reported and the UI always shows it.

## `previews[]`

```json
{
  "index": 1,
  "w": 1152.0, "h": 864.0,
  "art": [207.0, 96.59, 945.0, 784.92],
  "is_underbase": false,
  "choked": false,
  "raster_fallbacks": 0,
  "plates": [
    {"ink": "1-160&10-230-White", "colour": "#99e6d8",
     "src": "img/<slug>/ab1_....svg", "kind": "svg", "bytes": 94868}
  ]
}
```

- `w`/`h` are the artboard in points. `art` is the artwork's bounding box in
  **display coordinates** (y measured down from the top, matching the SVG), which
  is what lets a viewer centre on the design instead of on a mostly-empty 16in
  board.
- `is_underbase` — stack these underneath the colours, and exempt them from any
  "fade the colour" control.
- `choked` — this artboard carried zero-ink knockout strokes and the plates have
  been masked with them, so they match what the RIP burns.
- `kind` is `svg` or `png`. A plate too dense for vector falls back to a 600 dpi
  raster; tell the user, because it will soften at high zoom.
- `colour` is the ink's real alternate colour read out of the file, not a guess
  from the swatch name.

## `adjacency`

```json
{"5-230-Blue 286 C": {"perimeter_px": 6813, "abutting_px": 5191,
                      "abutting_pct": 76.2, "free_edge_px": 1622,
                      "is_white": false}}
```

The share of each colorant's perimeter that touches another ink, measured at
`MEASURE_DPI`. `TRAP_AT_NEGATIVE_SPACE` thresholds on `abutting_pct`:
above 85% no trap is needed, 70–85% it is optional, below 70% untrapped is a
fail. **Those numbers were calibrated at 200 dpi** — changing `MEASURE_DPI`
moves them.

## `ctx`

Derived values the detectors consumed. The useful ones:

- `has_underbase` — bool
- `trap_strokes` — `{"0.75|@devicek": 51}`, keyed `width|ink`. An `@`-prefixed
  ink is a device colourspace, i.e. a zero-ink knockout: a choke. A named ink
  means the stroke adds: a spread.
- `based_inks` — which colours actually sit on the base (≥85% of their area).
  Only these can meaningfully be out of register with it.
- `register_pair` — `[colour_bbox, base_bbox, delta]` in points.
- `coverage` — per-ink percentage sitting on the base.
