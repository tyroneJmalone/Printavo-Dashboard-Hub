---
name: Makeups new-line slips
description: New additions to invoice 22787 replace the former Hub PO submission trigger.
---

Makeups invoice #22787 prints summaries for newly added lines, including lines
in newly added groups, regardless of where purchases are placed. The user chose
the next AutoPrint run with “PO not assigned” rather than waiting for a PO.
Use the linked Printavo PO number in the same position as a Hub PO number.

**Why:** Hub-only PO submission missed purchases placed through other processes.

**How to apply:** Preserve the full-workorder skip. Capture exact new-line IDs,
descriptions and current invoice size quantities. Separate distinct assigned POs,
and show unavailable order date, vendor or warehouse explicitly. A later PO
assignment or Hub submission must not duplicate the new-line slip.

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
