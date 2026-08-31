---
name: Running one-off TS harness scripts against api-server internals
description: tsx is NOT installed anywhere in this workspace — bundle harness scripts with esbuild instead
---

The rule: to run a throwaway TypeScript harness that imports api-server internals (sync engine, routers, workspace packages), bundle it with esbuild using the same config shape as `artifacts/api-server/build.mjs`, then run the bundle with node. Delete both the harness and the build script afterward.

**Why:** `pnpm exec tsx` and `npx -y tsx` both fail — tsx is not a dependency in any workspace package and npx can't provision it here. Workspace packages (`@workspace/*`) are TS source, so they must be bundled, and anything importing the logger needs `esbuild-plugin-pino` (with `pino-pretty` transport) or the bundle crashes at runtime.

**Simpler runner that already works:** `artifacts/api-server/test-voice-profiles.mjs` / `test-draft-backtest.mjs` are kept esbuild runners (no pino plugin) — copy that pattern and run with `NODE_ENV=production node <runner>.mjs`. Without NODE_ENV=production the logger requests the pino-pretty transport and the bundle crashes with "unable to determine transport target".

**How to apply:** copy the esbuild invocation from `artifacts/api-server/build.mjs` (banner + pino plugin + `platform: node, format: esm, bundle: true`, external at least `["*.node","pg-native","lightningcss","sharp"]`), point `entryPoints` at the harness, output to a scratch dir, run with `node --enable-source-maps`. Keep the throwaway build script under `artifacts/api-server` even when the output is in `/tmp`; placing the build script in `/tmp` breaks `esbuild-plugin-pino` dependency resolution. Env vars (DB URLs, Printavo creds) are already in the shell env.
