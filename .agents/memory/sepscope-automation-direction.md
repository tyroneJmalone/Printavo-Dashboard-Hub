---
name: SepScope scheduled intake direction
description: Proposed Printavo intake, action targets and Dropbox archive matching; not authorization to enable automation.
---

The user is exploring scheduled inspections of Printavo production files instead
of constant monitoring, with an email notification upon inspection failure.
Output/separation filenames always end in the term OUTPUT (before the extension);
match case-insensitively.

The specified task is " Prep Separations- Confirm ART has been approved".
The specified failure status is "PRINT ERROR - REVIEW".
The schedule must be configurable in app settings, including additional run
times; the user chose 6:30 a.m. as the starting time. Timezone has not been
explicitly confirmed.
Start with staff approval required for every action, with an AutoPrint-like
toggle to enable automatic actions later. Inspection itself can be scheduled.
Ignore the artwork-approval wording in the task: the user says orders reaching
this stage are assumed approved.

**Why:** The user explicitly chose these controls and clarified that the task's
approval wording is historical, not an additional approval prerequisite.

Multiple-output completeness remains unresolved. The user's hypothesis is that
each PRINT imprint pricing matrix corresponds to a print location: front, back
and sleeve would have three imprints. This is a proposed indicator, not an
approved counting algorithm or evidence that a file exists for each location.

Dropbox client folders should match the Printavo invoice customer name. An
existing subfolder should already be named with the invoice number starting
with "#"; the user suggests invoice-number matching as the best approach.

**Why:** The user supplied these operational conventions while discussing
automatic inspection, task completion, failure status changes, and moving
successfully inspected files from Printavo to the client's invoice folder.

**How to apply:** Treat these as requirements for the proposed expansion, not
permission to activate writes or delete files. Timezone, multiple-output
completeness rules, and API deletion support remain unresolved. Preserve
staff approval by default; do not interpret the future toggle as permission
to auto-approve incomplete invoices.
Search for an existing invoice folder within the verified customer's root;
do not silently create folders or pick an ambiguous/cross-customer match.
Preserve the current pilot and Dropbox read-only restrictions until the
new write workflow is explicitly approved.
