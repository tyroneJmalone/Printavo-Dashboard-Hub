---
name: Purchasing rule priority safety
description: Preserve explicit rule order and confirm current environment before correcting shadowed keyword rules
---
Purchasing priority fixes should move the specific rule above its general fallback, preserve mixed-decoration precedence and destinations, and never re-evaluate existing suggestions or mutate invoice statuses as a side effect.

**Why:** The user approved a narrow Deadline/RUSH priority correction, not an automatic specificity-based routing policy. Read-only verification found that production had already replaced the development rule set with a different routing policy.

**How to apply:** Re-read the target environment before any saved-rule correction. Do not copy development rules into production or resurrect missing rules on the strength of an older task description; obtain a decision on the current policy instead.
