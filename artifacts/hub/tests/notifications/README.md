# Isolated AutoPrint notification browser harness

Run from the workspace root:

```sh
pnpm --filter @workspace/hub exec vite --config tests/notifications/vite.config.ts
```

Open `http://localhost:5180/auto-print` in a test browser. This is a separate
test entry point, not a route or authentication bypass in the real Hub.
It imports the production AutoPrint page, AppShell, notification components,
generated API hooks, and retry queue without copying their UI logic.

To run the saved Playwright regression suite (requires a Chromium installation
compatible with Playwright):

```sh
pnpm --filter @workspace/hub exec playwright install chromium
pnpm --filter @workspace/hub run test:notifications
```

The test config starts the isolated server automatically if it is not already
running. Screenshots and runner output go to `/tmp`, not the repository.

## Safety boundaries

- The test Vite config aliases only staff identity and the Clerk hook. The
  Clerk SDK is never loaded; no sign-in or OTP email is possible.
- `mock-api.ts` replaces fetch before React renders. It **never** calls the
  original fetch: missing fixtures fail explicitly with 501; unrelated
  mutations fail with 403. It has no credentials, database, or printer access.
- Mark read is stored in browser localStorage per fictional administrator.
  This verifies browser behavior against the API contract, not server-side
  authorization or database isolation (covered by backend tests).
- Test browsers should additionally block outbound API and external network
  requests. UI assets are served locally.
- Settings return null intentionally; configuration and running print jobs
  are outside this harness's scope.
- The normal Hub build does not import these files.

## Test controls

Set localStorage, then reload when changing identity. Reload creates a fresh
query cache, matching an independent sign-in session.

| Key | Values / behavior |
| --- | --- |
| `test-role` | `admin` (default), `manager`, `staff` |
| `test-admin` | `admin-a` (default), `admin-b` |
| `test-list-error` | Any nonempty value makes notification GET return 503 |
| `test-read-error` | Any nonempty value makes mark-read POST return 503 |
| `test-reads-admin-a` | JSON array of acknowledged fixture IDs |
| `test-reads-admin-b` | Independent acknowledgment array |

Remove error keys to restore success; use the real Refresh/Retry controls.
`window.notificationTest.requests` records mock calls since the latest page
load, including method, path, and fictional admin.

There are 35 alerts, with a 30-item first page. `alert-1` links to a scheduled
retry, `alert-3` to an unknown submission, `alert-4` to the recent run, and
`alert-8` to an older run outside the recent list.
