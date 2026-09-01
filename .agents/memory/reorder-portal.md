---
name: Reorder Portal public surface
description: Design decisions and invariants for the customer-facing reorder portal (public no-auth API + staff inbox module).
---

# Reorder Portal public surface

- **Accepted exposure model (Tyler's choice):** phase 1 deliberately allows unauthenticated lookup of invoice history by exact customer email or company substring (parity with his retired standalone portal). Architect review flagged this as cross-customer disclosure; the agreed mitigation is a later phase (private per-customer links / verification), NOT removal. Don't re-litigate; don't expand exposed fields (no payment/outstanding amounts, no contact internals, invoices only, Chipply shells excluded).
- **Public-write invariant:** any public submit endpoint must re-validate eligibility server-side with the SAME filters the public read uses (invoice + non-Chipply + line-item ownership) and trust the DB snapshot over client-supplied identity fields.
- **LIKE searches on public routes must escape `\ % _`** (Postgres default escape is backslash) or `q=%%` matches everything.
- **`trust proxy` is set to 1 app-wide in api-server** so `req.ip` is the real client behind the Replit edge — per-IP rate limits depend on it. Limits are in-memory per process (reset on restart) — acceptable for now, known limitation.
- **Email guard:** reorder request emails go to info@ only when `REORDER_EMAIL_MODE=live`; otherwise redirected to tyler@ with a `[TEST→…]` subject. **Production needs REORDER_EMAIL_MODE=live set at publish time** or sales notifications silently go to Tyler only.
- Staff side is the `reorder` module (module registry + Hub `/reorder-requests` page); requests live in `reorder_requests` (no FK to pv_orders — intentional, snapshot rows can vanish upstream).
