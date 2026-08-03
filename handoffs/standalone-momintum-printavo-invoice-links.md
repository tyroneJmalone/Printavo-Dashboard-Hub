# For the standalone moMINTum app: clickable Printavo invoice links in task titles

Paste this whole document to the agent working on the standalone moMINTum app.

## What to build
Printavo-synced tasks have titles ending in `(INV #NNN)`, and their **notes** contain the
staff-facing Printavo order URL (written once at task creation by the Hub's sync — it is
already in the shared database, no backend or sync changes are needed). This feature turns
that `(INV #NNN)` suffix into a clickable link that opens the order in Printavo in a new
tab, everywhere task titles are shown, plus an "Open order in Printavo" link in the task
detail dialog.

This is a frontend-only change: one new component file plus a few call sites.

## 1. New file: `src/components/tasks/printavo-order-link.tsx`

```tsx
/**
 * Printavo-synced tasks carry a trailing "(INV #NNN)" suffix in their title,
 * and their notes contain the staff-facing Printavo order URL (written once
 * at twin creation by the hub's sync). These helpers turn that suffix into a
 * clickable link that opens the order in Printavo in a new tab.
 */

const TITLE_SUFFIX_RE = /^(.*)(\(INV #[^)]+\))(\s*)$/;
const INVOICE_URL_RE = /https:\/\/www\.printavo\.com\/invoices\/\d+/;

export function getPrintavoOrderUrl(
  notes: string | null | undefined,
): string | null {
  return notes?.match(INVOICE_URL_RE)?.[0] ?? null;
}

export function TaskTitleWithPrintavoLink({
  title,
  notes,
}: {
  title: string;
  notes?: string | null;
}) {
  const match = title.match(TITLE_SUFFIX_RE);
  const url = match ? getPrintavoOrderUrl(notes) : null;
  if (!match || !url) return <>{title}</>;
  return (
    <>
      {match[1]}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
        title="Open order in Printavo"
      >
        {match[2]}
      </a>
    </>
  );
}
```

Notes:
- `onClick={(e) => e.stopPropagation()}` matters: task rows are clickable (open the
  detail view), and the link must not trigger that.
- If the app's link color utility differs, adjust `text-primary hover:underline`
  to match the app's styling conventions.

## 2. Call sites — replace plain title rendering

Wherever a task title is rendered as plain text (task list rows, completed page, and any
week/calendar chips that show titles), replace:

```tsx
{task.title}
```

with:

```tsx
<TaskTitleWithPrintavoLink title={task.title} notes={task.notes} />
```

(import: `import { TaskTitleWithPrintavoLink } from "@/components/tasks/printavo-order-link";`)

The component is a safe drop-in: when the title has no `(INV #...)` suffix or the notes
contain no Printavo URL, it renders the plain title unchanged.

In this workspace's version the call sites were: the task list item component, and the
Completed page. Find the standalone equivalents (search for where `task.title` is
rendered).

## 3. Task detail dialog — "Open order in Printavo" link

In the task detail view, add a link when the notes contain a Printavo URL:

```tsx
{getPrintavoOrderUrl(task.notes) && (
  <a
    href={getPrintavoOrderUrl(task.notes)!}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
  >
    <ExternalLink className="w-3 h-3" />
    Open order in Printavo
  </a>
)}
```

(`ExternalLink` from `lucide-react`.)

## Constraints
- Do NOT change how tasks are created, synced, or stored — the invoice suffix and the
  URL in notes come from the Hub's sync and are already present in the shared database.
- Do NOT strip or rewrite the `(INV #NNN)` suffix in titles; other tooling relies on it.
- No backend, schema, or API changes of any kind. Frontend only.
