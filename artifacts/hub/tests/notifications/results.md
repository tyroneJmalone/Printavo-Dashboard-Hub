# AutoPrint notification journey — browser results

Harness only: `http://localhost:5180/auto-print`, after the harness was
corrected to import `styles.css` with production `index.css` and
`@source ../../src`. Real AppShell/AutoPrint components remained isolated behind
mock identity/fetch and browser route blocking. No production Hub/Clerk, live
API, DB, printers, or email was used.

## Previous functional pass

- Admin notification content, per-admin read persistence, mark-read error/retry,
  pagination, current-page filters/empty state, refresh and fresh-load errors,
  Retry restore, and alert-1/3/4/8 linked job/run views passed as recorded in
  the earlier pass. Unknown-submission reconciliation and retry controls were
  inspected only; none were submitted. Manager/staff had no bell, inbox, retry
  queue, or notification/retry calls.
- The earlier `position: static` 1425×7636 desktop and 375×8548 mobile
  measurements came from the incomplete isolated styling root and were a
  **harness defect**, not a production layout result. Those measurements are
  superseded by the focused retest below.

## Focused visual/dismissal retest

- Fresh reload with `test-role=admin`, `test-admin` removed, and list/read error
  flags cleared. Production styling is present: dark themed shell, aligned
  cards, colored categories, warning callout, fixed header/sidebar.
- Expanded desktop AppShell sidebar bell: visible at `(145,33)`, `34×34`.
  After the one-line `lg:z-20` AppShell fix arrived via Vite HMR, the popover
  remained `position:absolute`, bounds `(145,71)–(585,901)`, size `440×830`,
  within the `1440×1000` viewport. Hit tests at x=155, 235, 295, and 575
  (y=221) all resolved inside the dialog, including two points outside the
  240px sidebar. Clicking its previously obscured “Open inbox” link succeeded,
  left the URL at `#autoprint-notifications`, and closed the dialog. The
  expanded-sidebar occlusion is fixed.
- Collapsed-sidebar AppShell header bell: visible at `(1394,9)`, `34×34`.
  Its popover fits at `(988,47)–(1428,877)`, size `440×830`; card list is
  `414×600`, `overflow-y:auto`, with 7,147px content. Dragging its scrollbar
  moved list `scrollTop` to 4,673 while document `scrollY` stayed 0.
- Desktop Escape dismissed the dialog; outside click dismissed it; “Open inbox”
  navigated to `#autoprint-notifications` and closed the popover.
- Mobile `390×844`: header bell visible at `(344,9)`, `34×34`. Its fixed
  popover fits at `(8,56)–(382,792.4)`, size `374×736.4`; inner list is
  `348×506.4`, `overflow-y:auto`, with 8,353px content. Dragging its scrollbar
  advanced `scrollTop` to 6,551 while the dialog stayed fixed and document
  scroll stayed 0. Escape and outside click both dismissed the mobile dialog.
- Mobile drawer bounds settled at `(0,0)–(240,844)`; no notification bell is
  present inside the drawer. The header bell is the available mobile placement.

## Safety, errors, and evidence

- The `/api/` and external-host browser route guard remained installed. No
  browser API request reached the network guard; the intentionally blocked
  Google Fonts stylesheet logged `net::ERR_FAILED`. Vite reconnect/development
  logs were also observed. Settings continued to show “Loading settings…”
  because the harness intentionally returns null; settings/run actions were
  not tested.
- Evidence IDs: corrected styling `fk5x1v`; pre-fix expanded-sidebar occlusion
  `nlmghp` / `ad5nlc`; post-HMR expanded popover and hit-test pass `0dd6jf`;
  post-click inbox `yenkzs`; collapsed desktop popover `dnvsxr`, scrolled cards
  `bfa9nj`; mobile popover `8f27sl`, scrolled cards `w9xqv3`; drawer `xpydbl`;
  mobile outside-dismiss result `kq3img`.
- Updated reusable script: `browser-journey.spec.ts`. Bell interactions now
  select the visible AppShell bell, assertions use Playwright auto-retrying
  locators, and visual coverage checks expanded/collapsed desktop and mobile
  drawer/scroll/dismissal states. It has not yet been run end-to-end. When run
  with Playwright Test it writes screenshots to `/tmp/autoprint-notifications`.
  This browser tool exposes
  screenshot IDs but no filesystem export path, so current pass images were
  not copied to `/tmp`.
