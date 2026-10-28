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
Dropbox client folders should match the Printavo invoice customer name. An
existing subfolder should already be named with the invoice number starting
with "#"; the user suggests invoice-number matching as the best approach.

**Why:** The user supplied these operational conventions while discussing
automatic inspection, task completion, failure status changes, and moving
successfully inspected files from Printavo to the client's invoice folder.

**How to apply:** Treat these as requirements for the proposed expansion, not
permission to activate writes or delete files. Schedule/timezone, recipients,
automatic versus reviewed approval, and API deletion support remain unresolved.
Search for an existing invoice folder within the verified customer's root;
do not silently create folders or pick an ambiguous/cross-customer match.
Preserve the current pilot and Dropbox read-only restrictions until the
new write workflow is explicitly approved.
