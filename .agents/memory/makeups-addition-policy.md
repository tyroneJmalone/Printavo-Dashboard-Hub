---
name: Makeups new-line slips
description: New additions to invoice 22787 replace the former Hub PO submission trigger.
---

Makeups invoice #22787 prints summaries for newly added lines, including lines
in newly added groups, regardless of where purchases are placed. Only lines with
Goods Status “Attached to PO” or “Ordered” qualify; “Needs Ordering” and all other
statuses wait without consuming the new-line eligibility. If an eligible line has
no linked PO, show “PO not assigned”. Include the line's Decoration Category.
Use the linked Printavo PO number in the same position as a Hub PO number.

**Why:** Hub-only PO submission missed purchases placed through other processes.
The user subsequently required the goods-status gate to avoid printing lines
before ordering, and requested Decoration Category on the slip.

**How to apply:** Preserve the full-workorder skip. Capture exact new-line IDs,
descriptions and current invoice size quantities. Print each new line on its own slip,
even when multiple additions share a PO or have no assigned PO,
and show unavailable order date, vendor or warehouse explicitly. A later PO
assignment or Hub submission must not duplicate the new-line slip.

**Why:** The user clarified that different new line items often belong to different
orders requiring different handling. Keep all sizes of one line together, but never
combine separate new lines merely because their PO matches.

The first complete live production run establishes the baseline without printing
historical lines; subsequent complete observations reserve slips and advance the
cumulative baseline atomically. Dry runs do not establish or consume the baseline.
Moving an existing line to another group is not a new line. Empty groups have
nothing to print; later new lines in them qualify. Observations are polling-based,
not an upstream event stream.

**Why:** Enabling the feature must not print the full historical Makeups invoice,
and restarts, edits, or uncertain printer acceptance must not cause duplicate slips.

Printavo returns `null` counts for unused size columns on otherwise valid lines.
These mean blank/zero, not invalid quantities.

**Why:** Real additions with a valid positive quantity were blocked because the
validator rejected the other, unused size columns.

**How to apply:** Accept explicit null size counts while rejecting negative,
fractional, nonnumeric, or otherwise malformed nonblank counts. Do not reset the
baseline to work around a rejected observation.
