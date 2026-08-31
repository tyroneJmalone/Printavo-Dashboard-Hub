---
name: Module access gating
description: Hub per-module readiness switches — registry claims API prefixes; new route families must be claimed or they bypass the gate.
---

The Hub has admin-managed "module access" switches (Settings → Module access) deciding which modules non-admin staff (staff AND manager roles) can see and use. Admins bypass. Default is everything OFF for non-admins.

**The rule:** any NEW top-level API route family (new first path segment mounted after `requireStaff`) that belongs to a user-facing module must be claimed in the module registry (`api-server` → `lib/auth/moduleAccess.ts` `MODULE_DEFS.apiPrefixes`), and its pages added to the AppShell `MODULE_PAGE_PREFIXES` map + nav-item `module` tags. Unclaimed prefixes are reachable by ALL staff (only role/capability guards apply).

**Why:** the gate matches only the first path segment against claimed prefixes; overlapping claims are intentional (product-finder and purchasing both claim /purchasing — enabled if ANY claimant is on). Framed to Tyler as readiness gating, not inter-staff security — real security stays in role/capability checks (email ACLs, requireAdmin, admin PIN).

**How to apply:**
- Intentionally unclaimed: /auth, /sync, /email-activity, /email-access, /printavo (existing capability/admin guards govern).
- Frontend calls made on always-visible surfaces (Settings page, AppShell badges) must be gated on `useStaff().enabledModules` or they 403 for non-admins (vendor ship-to + needs-ordering badge already handled).
- moMINTum artifact's StaffGate shows a lock screen when the momintum module is off.
- Storage: app_settings key `module_access` {enabled:[keys]}; 10s in-memory cache in the API server; PUT is full-replace (last-write-wins accepted — effectively single admin).
