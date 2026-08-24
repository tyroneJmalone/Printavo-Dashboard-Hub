---
name: html-to-image off-screen capture pitfalls
description: Two silent blank-output causes when capturing an off-screen clone with html-to-image (toPng)
---

Capturing a DOM node with html-to-image by cloning it and parking the clone off-screen has two silent failure modes that both produce a "blank" PNG with only the background color:

1. **Off-screen offsets are copied into the render.** toPng inlines each element's *computed* styles onto its internal render clone — including `position: absolute; left: -Xpx` used to hide the capture node. The content then draws outside the SVG viewport and the PNG is background-only. Fix: pass `style: { position: "static", left: "0", top: "0", margin: "0" }` in the toPng options (applied to the render clone root only; the on-page clone stays hidden).

2. **Appending the clone to document.body loses inherited styles.** Text color, font-family, etc. inherited from ancestors of the original node resolve against `body` instead — dark-theme apps get near-invisible (default black) text on dark backgrounds while explicitly-colored elements still show. Fix: append the capture clone to `node.parentElement`, not `document.body` (absolute positioning keeps it out of layout).

**How to apply:** any html-to-image/dom-to-image capture of a cloned or off-screen node needs both fixes. Symptom of #1 is a fully blank image; symptom of #2 is partial text missing (only inherited-color text). Verified via 3-variant side-by-side repro in the mockup sandbox (Aug 2026, Hub price calculator PNG push).

Also note: the hub_calc_uploads dedupe key blocks re-pushing identical price rows, so after a bad PNG was pushed, the stale row must be deleted for the user to re-push the corrected image.
