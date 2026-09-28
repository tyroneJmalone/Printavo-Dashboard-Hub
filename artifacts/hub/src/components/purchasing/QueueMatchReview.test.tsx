import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueMatchReview } from "./QueueMatchReview";
import type { CartItem } from "../../stores/poCart";

test("failed/unresolved row exposes search for the selected vendor without opening a hidden review", () => {
  for (const vendor of ["sanmar", "ss"] as const) {
    const markup = renderToStaticMarkup(<QueueMatchReview
      item={{ key: "line", styleNumber: "3001CVC", vendor } as CartItem}
      unresolved result={undefined} onStyle={async () => {}} onApprove={async () => {}} />);
    assert.match(markup, /<details[^>]*open=""/);
    assert.ok(markup.includes(`Search ${vendor === "sanmar" ? "SanMar" : "S&amp;S"} style`));
    assert.ok(markup.includes('data-testid="search-vendor-style-line"'));
  }
});