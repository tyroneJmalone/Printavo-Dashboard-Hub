---
name: Tailwind v4 arbitrary values — commas are literal
description: Comma-separated arbitrary values like grid-cols-[400px,1fr] silently no-op under Tailwind v4; use underscores.
---

Tailwind v4 (this repo uses ^4.x) does NOT convert commas to spaces inside arbitrary values the way v3 did. `grid-cols-[400px,1fr]` emits `grid-template-columns: 400px,1fr` — invalid CSS the browser silently drops, so the layout quietly renders as if the class weren't there (no build error, no console warning).

**Why:** the Price Calculator's "side-by-side" layout had been silently stacking full-width for this exact reason; only a screenshot revealed it.

**How to apply:** for space-separated CSS values in arbitrary classes, use underscores: `grid-cols-[300px_1fr]`, `shadow-[0_0_10px_...]`. Commas are correct ONLY where the CSS property itself is comma-separated (e.g. `transition-[color,box-shadow]`, rgba() args). When a Tailwind layout class "doesn't work", check for this before debugging anything else — verify visually with a screenshot, not just tsc/build success.

## Isolated browser harnesses

When a separate Vite test root imports production components, explicitly include
their directory with Tailwind `@source` in the harness stylesheet.

**Why:** importing the production stylesheet alone did not generate component
utilities under an isolated test root. Dialogs appeared as unstyled, static
document content, falsely suggesting a production positioning bug.

**How to apply:** verify computed utilities (such as `position: fixed` or
`absolute`) before treating harness screenshots as evidence of application
layout defects.
