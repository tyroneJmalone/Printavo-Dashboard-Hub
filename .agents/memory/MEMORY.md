# Memory Index

- [Printavo sync engine](printavo-sync-engine.md) — v2 API limits, per-invoice sync cost (~5h full crawl), what the backup repo already fetches vs. missing, and proven watermark/checkpoint patterns to port.
- [Printavo reporting formulas](printavo-reporting-formulas.md) — exact revenue/qty formulas, imprint revenue split, cash-basis payments, filter semantics, email schedule timing rules Hub must replicate.
- [Printavo print engine](printavo-print-engine.md) — public workorder URLs vs session-gated packing slips, Puppeteer login workaround, PrintNode auto-print flow, category→status routing.
- [Breezy pricing & vendor clients](printavo-breezy-pricing.md) — unit-price formula, matrix jsonb shape, S&S price-field semantics, SanMar SOAP structure + base-size trick, sale detection rules.
- [PO Builder scan & mutations](printavo-po-builder.md) — two-pass need_ordering scan, complexity/rate limits, lineItemUpdate position gotcha, productionFileCreate push, SanMar field conflict vs Breezy.
- [Mint Bucks credits & throttle](printavo-mint-bucks.md) — store-credit ledger is system of record, advisory-lock budget claims, 620ms shared throttle, orders-union/quote quirks, no paidAt field.
- [Shipping estimator](printavo-shipping-estimator.md) — ShipStation vs EasyPost dual quotes, EasyPost carries real UPS discounts, garment weight constants, preset boxes, older non-monorepo template.
- [ColorCatalog cross-reference](printavo-color-catalog.md) — ~6.2k-row Pantone↔thread/ink table, stock-propagation rule, custom Delta E CIE2000 matcher + LAB cache, older non-monorepo template.
- [PDF Sorter](printavo-pdf-sorter.md) — Python child-process pdfplumber parsing of Printavo slips + USPS labels, name-match algorithm, size sort constant, modern monorepo template, no secrets.
