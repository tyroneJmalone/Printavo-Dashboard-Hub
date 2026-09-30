---
name: Pipeline status policy
description: User-approved stage mappings and invoice eligibility for Nurturing.
---

Nurturing includes both quotes and invoices, including approved and Art statuses.
Art wins over completion wording: ART - COMPLETE is Nurturing, not Done.
Genuine Dead/Archive exclusions still take precedence.

**Why:** The user explicitly wants these records in the sales pipeline regardless
of Printavo document classification; conversion to an invoice does not mean the
sales follow-up work is finished.

**How to apply:** Keep row eligibility and stage totals consistent with the
classifier. Recognize Ready 2 Go, Ready 4 Production, and Ready 2 Pick/Pack as
Won; Picked Up, Shipped, Delivered, and Billed as Done. Match Dead as a whole
word: substring matching wrongly classifies FIRM DEADLINE as Dead. Preserve
existing date-window rules separately from these stage rules.