---
name: Canonical plan & status report
description: Where Tyler's recurring status/roadmap PDF lives and how to update it
---

The status report Tyler reviews/forwards is `exports/printavo-hub-plan-status.html` → rendered to `exports/printavo-hub-plan-status.pdf` (copy also kept at `artifacts/hub/public/plan-status.pdf`).

**Why:** On Aug 7, 2026 a fresh differently-styled PDF was created instead of updating this one; Tyler immediately flagged the mismatch. He treats this styled sheet (two-column, DONE/YOUR TEST badges, punch list, backlog grid, "since last report" footer) as the living document.

**How to apply:** When asked for a status/roadmap/plan PDF, edit the existing HTML in place (keep its CSS/template, update date, punch list, sections, footer delta) and re-render with puppeteer-core + the nix chromium binary (`readlink -f $(which chromium)`; import puppeteer-core via its exact `.pnpm` path since the workspace root has no direct dep). `docs/status-and-roadmap.md` is the markdown working copy; the HTML sheet is what Tyler sees.
