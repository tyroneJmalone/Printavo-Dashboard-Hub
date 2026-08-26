---
name: Email access role model
description: Durable role and mailbox rules for Email Activity and Correspondence
---

Admin has full read/search/AI access to every email mailbox and correspondence
thread, including protected personal mailboxes and mailboxes without a policy.
Manager does not inherit general workspace mailbox access: Manager access comes
from selected mailbox Groups, mailbox ownership, or an explicit conversation
grant. Staff may still use explicitly configured workspace access as well as
ownership, Groups, and conversation grants.

Customer profiles aggregate email thread history across every mailbox the
current user can read, plus individually granted threads without broadening
that grant to the rest of its mailbox. They must not require the UI to choose
one mailbox.

**Why:** The project owner explicitly corrected the role model after the first
privacy rollout hid customer thread history and treated Admin like every other
role.

**How to apply:** Keep mailbox scoping in SQL before retrieval. Use all tracked
mailboxes for Admin; resolve only selected Groups/ownership/thread grants for
Manager. Any customer-level correspondence query must accept the resolved
mailbox set and aggregate only within it.