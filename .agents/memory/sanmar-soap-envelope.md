---
name: SanMar SOAP envelope ordering
description: SanMar PO SOAP service requires strict WSDL sequence order and credentials in arg1 — violations cause NullPointerException faults
---

# SanMar PO SOAP envelope rules

**Rule:** SanMar's PO service (JAX-WS doc/literal) unmarshals `xs:sequence` types positionally. Every element inside `arg0` (webServicePO) and each detail line must appear in exact WSDL order, and credentials go in a **separate `arg1` (webServiceUser) element — never inside arg0**. Omitting `minOccurs=0` elements is fine; reordering is not.

**Why:** The first-ever live submit (2026-07-13) failed with `SanMar SOAP fault: java.lang.NullPointerException`. Out-of-order elements silently parse as null on SanMar's side and their server NPEs with no useful message. The other SanMar services (product info, inventory) were forgiving; the PO service is not.

**How to apply:**
- Never guess or reorder fields in the PO envelope builder — the authoritative order is the live WSDL at `SanMarPOServicePort?wsdl` (alphabetical-ish sequence; documented in the builder's comment).
- To verify envelope changes safely, call `getPreSubmitInfo` (same arg0/arg1 shape as `submitPO`) against PROD — it validates a real payload, confirms inventory, and places NO order; safe to retry.
- `getPreSubmitInfo` goes through the retrying soapCall() which THROWS on errorOccurred=true — callers must try/catch, not rely on `result.success`.
- `submitPO` stays single-attempt with ambiguous-network handling; never add auto-retry.
