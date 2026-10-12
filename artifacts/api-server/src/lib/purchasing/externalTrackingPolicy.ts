export const referenceKey = (s: string) => s.trim().toUpperCase();
export const vendorComplete = (s: string | null) => !!s && /^(complete|completed)$/i.test(s.trim());

/** No punctuation stripping: 315/315 and 315315 need not be the same PO. */
export function matchesHub(
  candidate: {vendor:string; poNumber:string; snapshot:{orderNumbers:string[]}},
  rows: {vendor:string; poNumber:string; vendorOrderNumbers:unknown}[],
): boolean {
  return rows.some(r => r.vendor === candidate.vendor && (
    (!!candidate.poNumber && referenceKey(r.poNumber) === referenceKey(candidate.poNumber)) ||
    (Array.isArray(r.vendorOrderNumbers) && r.vendorOrderNumbers.some(n =>
      typeof n === "string" && candidate.snapshot.orderNumbers.some(v => referenceKey(v) === referenceKey(n))))
  ));
}
