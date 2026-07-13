---
name: Printavo WAF blocks repeated page loads in one browser session
description: Headless rendering of Printavo pages 403s after the first navigation unless each render uses a fresh incognito context
---

**Rule:** When rendering Printavo pages headlessly (e.g. workorder PDFs via Chromium), Printavo's WAF returns 403 on every `page.goto` after the first one in the same browser session. Delays between navigations (even 15s) do NOT help.

**Why:** Discovered during auto-print workorder rendering — first order rendered fine, all subsequent orders 403'd until the fix. Cost a full debugging cycle.

**How to apply:** Create a fresh incognito browser context (`browser.createBrowserContext()`) per order/page render and close it afterward, plus keep a ~2s delay between orders. With that pattern a 30-order batch renders 30/30. Renders take ~7–9s per order.
