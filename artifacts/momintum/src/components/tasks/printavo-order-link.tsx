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
