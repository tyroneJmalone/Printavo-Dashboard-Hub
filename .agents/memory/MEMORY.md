# Memory Index

- [Printavo sync engine](printavo-sync-engine.md) — v2 API limits, per-invoice sync cost (~5h full crawl), what the backup repo already fetches vs. missing, and proven watermark/checkpoint patterns to port.
- [Printavo reporting formulas](printavo-reporting-formulas.md) — exact revenue/qty formulas, imprint revenue split, cash-basis payments, filter semantics, email schedule timing rules Hub must replicate.
- [Printavo print engine](printavo-print-engine.md) — public workorder URLs vs session-gated packing slips, Puppeteer login workaround, PrintNode auto-print flow, category→status routing.
- [Breezy pricing & vendor clients](printavo-breezy-pricing.md) — unit-price formula, matrix jsonb shape, S&S price-field semantics, SanMar SOAP structure + base-size trick, sale detection rules.
- [PO Builder scan & mutations](printavo-po-builder.md) — two-pass need_ordering scan, complexity/rate limits, lineItemUpdate position gotcha, productionFileCreate push, SanMar field conflict vs Breezy.
