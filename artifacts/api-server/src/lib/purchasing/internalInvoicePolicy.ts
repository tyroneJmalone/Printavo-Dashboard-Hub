/** Internal replacement orders still belong on POs, but need no workorder or PO attachment. */
export function isInternalReplacementInvoice(visualId: number | string | null | undefined): boolean {
  return Number(visualId) === 22787;
}

type AttachmentLine = {
  printavoOrderId: string | null;
  visualId: number | null;
  status: string;
};

/** Filter only attachment destinations; never mutate or filter the PO's own lines. */
export function poAttachmentTargets(
  lines: readonly AttachmentLine[],
  attachedInvoiceIds: readonly string[],
  knownOrders: readonly { id: string; visualId: number | null }[],
): Map<string, number | null> {
  const excludedIds = new Set<string>();
  for (const line of lines) {
    if (line.printavoOrderId && isInternalReplacementInvoice(line.visualId)) excludedIds.add(line.printavoOrderId);
  }
  for (const order of knownOrders) {
    if (isInternalReplacementInvoice(order.visualId)) excludedIds.add(order.id);
  }
  const targets = new Map<string, number | null>();
  for (const line of lines) {
    if (
      line.printavoOrderId && !excludedIds.has(line.printavoOrderId) &&
      !attachedInvoiceIds.includes(line.printavoOrderId) &&
      (line.status === "done" || line.status === "skipped_ordered") &&
      !targets.has(line.printavoOrderId)
    ) targets.set(line.printavoOrderId, line.visualId);
  }
  return targets;
}