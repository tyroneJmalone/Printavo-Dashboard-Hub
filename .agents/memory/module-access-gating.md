---
name: Module access gating
description: Hub per-module readiness switches — new staff route families must be claimed in the module registry or they bypass the gate.
---

The Hub has admin-managed "module access" switches deciding which modules
non-admin staff (staff AND manager roles) can see and use. Admins bypass;
default is everything OFF for non-admins.

**The rule:** any NEW top-level staff API route family that belongs to a
user-facing module must be claimed in the module registry, and its pages
registered in the AppShell module page map. Unclaimed prefixes are reachable
by ALL staff — the gate only matches claimed first path segments.

**Why:** framed to Tyler as READINESS gating, not inter-staff security — real
security stays in role/capability checks (email ACLs, admin guards, PIN).
Overlapping prefix claims are intentional: a shared prefix is enabled if ANY
claiming module is on.

**How to apply:** when adding a staff-facing module or route family, claim it
in the registry + page map, and gate any frontend calls made from
always-visible surfaces on the enabled-modules list or they 403 for
non-admins. Some infrastructure prefixes are intentionally unclaimed and
governed by their own capability/admin guards.
