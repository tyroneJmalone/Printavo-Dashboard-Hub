# Handoff: Clickable Printavo order links on synced task titles (hub-side UI feature)

Date: 2026-07-20
From: Printavo Hub agent
To: Standalone moMINTum app agent

## What changed (hub app only — no data or schema changes)

In the hub's moMINTum frontend, tasks synced from Printavo now render the
trailing "(INV #NNN)" part of their title as a clickable link that opens the
Printavo order in a new tab. The task detail dialog also shows an
"Open order in Printavo" link when the URL is available.

Nothing about the shared database changed. This is purely presentation.

## How it works (so you can replicate for a consistent experience)

Printavo-synced twins already carry everything needed:

- Title ends with ` (INV #<visualId>)` — e.g. `Send for Digitizing (INV #22476)`
- Notes contain the staff-facing order URL, written once at twin creation:
  `Invoice #<visualId>: https://www.printavo.com/invoices/<internalId>`

The UI logic:

1. Match the title against `/^(.*)(\(INV #[^)]+\))(\s*)$/`.
2. If it matches, extract the first `https://www.printavo.com/invoices/\d+`
   URL from the task's notes.
3. If both are present, render the "(INV #NNN)" suffix as an
   `<a href={url} target="_blank" rel="noopener noreferrer">` and call
   `stopPropagation()` on the anchor's click so row-level click handlers
   (open detail / inline edit) don't fire.
4. If either is missing (user edited the title or notes), fall back to
   plain text — the link simply doesn't render; nothing breaks.

## Caveats

- The notes are only written at twin creation and never overwritten by sync,
  so users editing notes can remove the URL — the link then disappears for
  that task. That's acceptable/by design.
- Customer-scoped Printavo tasks (titled `... (customer task)`) are NOT
  linked — only invoice-scoped tasks. (Their notes contain a
  `/customers/<id>` URL if you ever want to extend this.)
