---
name: Auto-print decoration policy
description: Why auto-print routing follows Purchasing line-item decoration groups.
---
Auto-print should use Purchasing's line-item decoration classification, not imprint type-of-work, while retaining separate destination settings and successful-print timing. Mixed-decoration orders need a mixed destination, not a single-method fallback.

**Why:** A physically printed order had Screen Printing line items but blank imprint types, so the old matching never selected its configured destination. The user approved aligning classification with Purchasing after comparing the two systems.

**How to apply:** Preserve existing named mapping compatibility. Do not reuse Purchasing's destination statuses, ordering-completion guards, or suggestion workflow for auto-print. Do not automatically reprint or retroactively advance previously printed orders when changing routing rules.

AutoPrint may offer the same decoration, customer-due business-day, and nickname
conditions as Purchasing Status Rules, but with independently configured
destinations and only the successful-print trigger.

**Why:** The user explicitly requested condition/mapping parity so the same
kinds of routing decisions can be configured at either operational stage
without coupling the two settings.

**How to apply:** Share matching semantics, not live rule configuration.
Changing post-print routing must not modify PO-push rules or activate new
behavior for previously printed orders.