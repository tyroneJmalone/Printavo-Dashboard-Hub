---
name: Auto-print decoration policy
description: Why auto-print routing follows Purchasing line-item decoration groups.
---
Auto-print should use Purchasing's line-item decoration classification, not imprint type-of-work, while retaining separate destination settings and successful-print timing. Mixed-decoration orders need a mixed destination, not a single-method fallback.

**Why:** A physically printed order had Screen Printing line items but blank imprint types, so the old matching never selected its configured destination. The user approved aligning classification with Purchasing after comparing the two systems.

**How to apply:** Preserve existing named mapping compatibility. Do not reuse Purchasing's destination statuses, ordering-completion conditions, or suggestion workflow for auto-print. Do not automatically reprint or retroactively advance previously printed orders when changing routing rules.