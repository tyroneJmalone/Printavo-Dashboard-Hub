---
name: Printavo date display
description: Printavo calendar dates are stored at UTC midnight — format in UTC or the day shifts back one.
---

**Rule:** Any Printavo date shown to users (createdAt, customerDueAt, etc.) must be formatted with `timeZone: "UTC"`, never shop-local time.

**Why:** Printavo's created/due dates are calendar dates persisted at UTC midnight (blob `"2026-06-19"`, timestamp column `2026-06-19 00:00:00+00`). Formatting in `America/New_York` renders the previous day (June 19 → June 18). Caught during the packing-slip restyle when the slip disagreed with Printavo's own template by one day.

**How to apply:** When rendering any date sourced from pv_orders / Printavo blobs, treat it as a calendar date: `toLocaleDateString("en-US", { timeZone: "UTC", ... })`. Only genuinely time-of-day-meaningful timestamps (sync times, our own audit columns) should use shop-local time.
