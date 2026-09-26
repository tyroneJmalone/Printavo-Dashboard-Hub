---
name: Vite JSX generic instrumentation
description: Replit metadata injection can corrupt explicit generic JSX tags despite passing TypeScript.
---

Avoid explicit type arguments directly on JSX component tags in the Hub's
instrumented Vite development build. Use a typed component alias outside JSX
when generic inference is insufficient.

**Why:** The metadata instrumentation inserted attributes before a JSX generic
type argument, producing an invalid tag and a Babel runtime compile error.
TypeScript alone passed because the source before instrumentation was valid.

**How to apply:** For generic controls, specialize the function in an ordinary
TypeScript expression and render the resulting alias. Verify the Vite-served
module as well as the typecheck; do not disable instrumentation globally.