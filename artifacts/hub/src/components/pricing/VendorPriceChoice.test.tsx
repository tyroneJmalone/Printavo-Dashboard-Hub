import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { VendorPriceChoice, type VendorPriceSelection } from "./VendorPriceChoice";

const selection: VendorPriceSelection = {
  vendor: "sanmar", style: "PC54", color: "Black", brand: "Port & Company",
  description: "Cotton tee", baseSize: "S", cost: 4,
  regularPrice: 4, salePrice: 3, saleEndsAt: "2026-10-31",
  priceMode: "regular",
};

test("both vendor prices remain visible with the chosen mode pressed", () => {
  for (const mode of ["regular", "sale"] as const) {
    const html = renderToStaticMarkup(
      <VendorPriceChoice selection={selection} mode={mode} onChange={() => {}} />,
    );
    assert.match(html, /Regular \$4.00/);
    assert.match(html, /Sale \$3.00/);
    assert.match(html, new RegExp(`aria-pressed="true"[^>]*data-testid="calculator-price-${mode}"`));
    assert.match(html, /Sale ends 2026-10-31/);
  }
});

test("missing sale is disabled, not substituted with regular pricing", () => {
  const html = renderToStaticMarkup(
    <VendorPriceChoice selection={{ ...selection, vendor: "ss", salePrice: null }}
      mode="regular" onChange={() => {}} />,
  );
  assert.match(html, /S&amp;S Activewear/);
  assert.match(html, /disabled=""[^>]*data-testid="calculator-price-sale"/);
  assert.match(html, /Sale unavailable/);
  assert.doesNotMatch(html, /Sale ends/);
});

test("manual costs do not falsely show a vendor price as selected", () => {
  const html = renderToStaticMarkup(
    <VendorPriceChoice selection={selection} mode={null} onChange={() => {}} />,
  );
  assert.doesNotMatch(html, /aria-pressed="true"/);
  assert.match(html, /Manual cost/);
  assert.match(html, /Regular \$4.00/);
  assert.match(html, /Sale \$3.00/);
});
