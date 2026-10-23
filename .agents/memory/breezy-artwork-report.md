---
name: Breezy artwork reporting direction
description: Production-file extension as an artwork/proofing method indicator
---
The user handles artwork and proofing through multiple methods and wants to
understand their ratio. A `.breezy` production-file attachment on an invoice is
the only current indicator they identified. They asked about counting invoices
with such attachments during selected periods. The user approved building the
report, including clickable stat lines showing the contributing invoices.

**Why:** This is a proposed proxy for workflow adoption, not a confirmed exhaustive
classification of artwork methods.

**How to apply:** Count distinct invoices, not attachments. Do not label invoices
without `.breezy` as a verified alternative method or missing sync as no attachment.
Clarify invoice-period reporting versus file-upload-period reporting and distinguish
current attachment presence from historical presence. Validate real filenames and
sync coverage before asserting live counts or historical accuracy.

The user also wants an invoice-level indicator for a mockup on at least one
line item, plus the ability to exclude selected statuses.

**Why:** Mockup presence provides additional context for the denominator, but
is not mutually exclusive with a Breezy attachment. Observed live data showed
Breezy invoices also having line-item mockups; do not assume exclusive methods.

**How to apply:** Separate both, mockup-only, Breezy-only, and neither-observed
categories. Apply status exclusions to all denominators and numerators equally,
using current status rather than claiming historical status. Check extras
partial-error/truncation flags as well as freshness before confirming absence:
a snapshot not marked stale can still be incomplete.

Make multi-status exclusion easy in Artwork & Proofing, including selecting
MERCH statuses as a group.

**Why:** The user specifically requested excluding multiple statuses, with MERCH
as their example, rather than relying on a separate generic filter-inversion step.

**How to apply:** Keep exclusions explicit and editable. A MERCH shortcut matches
live status names, not invoice nicknames, and must not silently invert existing
Include-only selections into unrelated exclusions.

Include Merch invoices in the artwork report, unlike financial reporting's
shell-invoice exclusion. Keep it invoice-only and apply the same filters to
summary counts and drilldowns.

**Why:** This measures attachment adoption across invoices, not revenue; excluding
Merch solely to prevent revenue double-counting would distort this denominator.

**How to apply:** Explain the difference from financial totals. Exclusive workflow
categories require complete/current snapshots and partition with Unknown.
Observed Breezy/mockup counts may overlap Unknown, while the Breezy-among-mockups
percentage uses only fully checked mockup invoices. Never imply those categories
prove the actual artwork method.
