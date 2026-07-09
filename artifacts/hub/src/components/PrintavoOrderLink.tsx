/**
 * Clickable Printavo visual ID that opens the ADMIN view of the order
 * (www.printavo.com/invoices/{id} — same path for quotes and invoices),
 * NOT the customer-facing public URL.
 *
 * Falls back to plain text when the Printavo order id is unknown
 * (e.g. manually added PO lines).
 */
export function printavoAdminOrderUrl(printavoOrderId: string): string {
  return `https://www.printavo.com/invoices/${printavoOrderId}`;
}

export function PrintavoOrderLink({
  orderId,
  visualId,
  className,
  prefix = "#",
}: {
  orderId: string | null | undefined;
  visualId: number | string | null | undefined;
  className?: string;
  prefix?: string;
}) {
  if (visualId === null || visualId === undefined) return <>—</>;
  const label = `${prefix}${visualId}`;
  if (!orderId) return <span className={className}>{label}</span>;
  return (
    <a
      href={printavoAdminOrderUrl(orderId)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`${className ?? ""} hover:text-[#10b981] hover:underline underline-offset-2 transition-colors`}
      title="Open in Printavo"
    >
      {label}
    </a>
  );
}
