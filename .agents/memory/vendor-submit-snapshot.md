---
name: Vendor submission runs off the persisted snapshot
description: Why any new per-line PO field must persist end-to-end (openapi → snapshot → wire), and how the double-order guard works.
---

# Vendor submission happens LATER, from the persisted jsonb snapshot

In the Printavo Hub purchasing flow, electronic vendor submission (SanMar / S&S)
does NOT run at cart-save time. It runs later from the PO Log, off the PO file's
persisted jsonb `lineItems` **snapshot**. The cart (zustand `poCart`) is throwaway.

**Rule:** Any new per-size / per-line piece of data that the vendor wire or the
eligibility/preview logic needs at submit time must be persisted through the whole
chain — it cannot live only in the cart. The chain is:

1. `lib/api-spec/openapi.yaml` `PoFileSizeEntry` — add the field **optional +
   nullable, and NOT in `required`**. Two reasons: backward compat with old
   snapshots, and (critical) if it's absent from the schema, the generated zod
   **strips it from request bodies**, so create/append/update silently drop it.
2. Regenerate the client: `pnpm --filter @workspace/api-spec run codegen`.
3. Cart row type + save mapping (`poCart.ts`, `CartDrawer.handleSave`) must carry it.
4. Consumers read `field ?? fallback` so old snapshots still work
   (`vendorSubmit.ts`, `poHtml.ts`, `PoEditor` chips).

**Why:** SanMar's SOAP envelope sends the size LABEL on the wire
(`lib/sanmar/src/client.ts`). For combined sizes (S/M, L/XL) the Printavo column
is the first component ("S") but the vendor needs "S/M". That combined label
(`vendorSize`) had to reach the snapshot, or the later submission would send "S".

# Double-order guard (the shop's cardinal rule)

Two eligible lines resolving to the same vendor unit + warehouse = a double order.
The hard blocker lives in `vendorSubmit.ts` `buildEligibility`, keyed on
`style | color | WIRE SIZE (sanmar) / sku (ss) | warehouse`. The wire size is
`vendorSize ?? size` — the exact label SanMar/S&S orders by — so two Printavo
columns manually remapped to the same combined size (S and M both → "S/M")
collide and are blocked. It runs on the snapshot at submit time, so a dup saved
from the cart OR created later in PoEditor still cannot reach the wire. The cart
also shows a soft amber warning, but the snapshot-time blocker is the real net.

**Do NOT key on SanMar `inventoryKey`.** SanMar's inventoryKey is shared across a
whole size RANGE (BC3001 Black XS–XL all = 129389, distinguished only by
sizeIndex; PC61 S–XL = 17576). Keying dedup on it falsely flagged every normal
S/M/L/XL run as a duplicate. The per-line identity SanMar actually orders by is
style+color+size (see the wire envelope in `lib/sanmar/src/client.ts`).

**Friction (much reduced):** two legitimately-separate Printavo line items that
share style+color+SIZE+warehouse still trip this blocker (correctly — that IS a
double order); PoEditor has no merge-lines affordance, so combine qty by hand.
