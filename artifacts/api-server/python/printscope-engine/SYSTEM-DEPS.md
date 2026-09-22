# System binaries

Two non-Python tools do work nothing in Python does well. Both must be on PATH
before the engine will run.

| Tool | Verified version | Used for |
|---|---|---|
| Ghostscript (`gs`) | 10.02.1 | `-sDEVICE=tiffsep` — renders one greyscale plate per separation. Every raster measurement (trap adjacency, base coverage) is built on this. |
| MuPDF (`mutool`) | 1.23.10, 1.25.3 | `draw -F svg -O text=path` — renders an isolated plate to vector SVG for the preview. |

**Do not pin MuPDF.** 1.23 and 1.25 produce identical plate geometry; they differ
only in how the SVG root spells its dimensions (`width="1152pt"` vs
`width="1152"`). The engine accepts both and the golden test "svg dimensions
parse in both renderer formats" holds it to that. If a future version changes the
spelling again, `compose_knockout` raises `ChokeCompositionError` and the result
records it — it does not fall back to an un-choked plate. Pinning would have
hidden this class of problem rather than surfaced it.

**Debian / Ubuntu / Replit:**

```
apt-get install -y ghostscript mupdf-tools
```

**Replit `replit.nix`:**

```nix
{ pkgs }: {
  deps = [ pkgs.ghostscript pkgs.mupdf pkgs.python311 ];
}
```

Check both resolve before debugging anything else:

```
gs --version && mutool -v
```

If they live somewhere non-standard, point `PRINTSCOPE_GS` and
`PRINTSCOPE_MUTOOL` at them rather than editing code — see `config.py`.
