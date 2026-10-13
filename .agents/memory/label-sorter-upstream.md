---
name: Label Sorter upstream parity
description: Authoritative standalone source and intentional Hub integration boundaries.
---

The Hub's Shipping → Label Sorter should match the standalone Mint Sorter
(also called Breezy Sort), sourced from
https://github.com/tyroneJmalone/Mint-Sorter.

**Why:** The user explicitly chose full standalone-app parity rather than
bringing over only sorting bug fixes.

**How to apply:** Review upstream history and port its processing behavior and
corresponding UI together, including dependencies between older and newer
features. Preserve Hub staff/module access, Hub routing and download
conventions. Do not replace the Hub shell or import standalone deployment
configuration, customer sample documents, or generated batch outputs.
Verify with synthetic offline PDFs/CSVs; updating this module does not
authorize printing, vendor calls, or changing upstream invoice records.
