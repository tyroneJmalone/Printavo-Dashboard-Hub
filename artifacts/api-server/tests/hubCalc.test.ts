/**
 * Hub Price Calculator — pure-logic unit tests.
 *
 * All tests operate only on exported pure functions with zero infrastructure
 * dependencies. No Printavo mutations, no AI calls, no DB writes, no GCS access.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Pure helpers from pureHelpers.ts (no DB/GCS imports)
import {
  validatePriceRows,
  computeDedupeKey,
  sanitizeFilename,
  VALID_RANGE_KEYS,
  buildLineItemDescription,
  validateLineItemInput,
  normalizeLineItemInput,
} from "../src/lib/hub/pureHelpers.ts";
import { lineItemSnapshotsEqual } from "../src/lib/hub/calcLineItems.ts";
import { parseExtractedCalcResponse } from "../src/lib/hub/pricingInterpreter.ts";

// Pure helpers from calcPush.ts (exported for testing)
import {
  blockMarker,
  buildNoteBlock,
  spliceNoteBlock,
  noteContainsBlock,
  priceRowsEqual,
} from "../src/lib/hub/calcPush.ts";

// Query builder helpers from lib/printavo (no network)
import {
  invoiceByIdQuery,
  invoiceUpdateMutation,
  quoteByIdQuery,
  quoteUpdateMutation,
  calculatorLineItemGroupCreateMutation,
  orderLineItemGroupPositionsQuery,
} from "../../../lib/printavo/src/queries.ts";

test("buildLineItemDescription: includes brand, blank line, and concise selected breaks", () => {
  assert.equal(
    buildLineItemDescription(
      { brand: "Port & Company", description: "Core Cotton Tee" },
      [
        { qty: 12, unitPrice: 18.5 },
        { qty: 24, unitPrice: 16 },
      ],
    ),
    "Port & Company Core Cotton Tee\n\nQTY = PRICE\n12+ = $18.50\n24+ = $16.00",
  );
});

test("validateLineItemInput: requires every reviewed field", () => {
  assert.equal(
    validateLineItemInput({
      categoryId: "20421",
      itemNumber: "PC54",
      color: "Jet Black",
      brand: "Port & Company",
      description: "",
    }),
    "description is required when adding a line item",
  );
});

test("normalizeLineItemInput: trims and reconstructs the canonical field order", () => {
  assert.deepEqual(
    normalizeLineItemInput({
      description: " Tee ",
      brand: " Brand ",
      color: " Black ",
      itemNumber: " PC54 ",
      categoryId: " 20421 ",
    }),
    {
      categoryId: "20421",
      itemNumber: "PC54",
      color: "Black",
      brand: "Brand",
      description: "Tee",
    },
  );
});

test("line-item canonicalization: formatting variants share dedupe identity and snapshot equality", () => {
  const canonical = {
    categoryId: "20421",
    itemNumber: "PC54",
    color: "Black",
    brand: "Port & Company",
    description: "Core Cotton Tee",
  };
  const variant = {
    description: " Core Cotton Tee ",
    brand: " Port & Company ",
    color: " Black ",
    itemNumber: " PC54 ",
    categoryId: " 20421 ",
  };
  const base = {
    invoiceId: "invoice-1",
    visualId: 22779,
    rangeKey: "12-48",
    priceRows: [{ qty: 12, unitPrice: 18.5 }],
    quoteNumber: "22779",
  };
  assert.equal(
    computeDedupeKey({ ...base, lineItem: canonical }),
    computeDedupeKey({ ...base, lineItem: variant }),
  );
  assert.equal(lineItemSnapshotsEqual(canonical, variant), true);
});

test("calculatorLineItemGroupCreateMutation: safely emits category and description", () => {
  const mutation = calculatorLineItemGroupCreateMutation("inv-1", {
    position: 3,
    categoryId: "20421",
    itemNumber: "PC54",
    color: "Black",
    description: 'Port & Company "Core"\n\nQTY = PRICE\n12+ = $18.50',
  });
  assert.match(mutation, /lineItemGroupCreate/);
  assert.match(mutation, /position: 3/);
  assert.match(mutation, /category: \{ id: "20421" \}/);
  assert.match(mutation, /productStatus: null/);
  assert.doesNotMatch(mutation, /productStatus: need_ordering/);
  assert.match(mutation, /Port & Company \\"Core\\"\\n\\nQTY = PRICE/);
});

test("orderLineItemGroupPositionsQuery: supports invoice and quote roots behind a stable alias", () => {
  const invoice = orderLineItemGroupPositionsQuery("inv-1", "invoice");
  const quote = orderLineItemGroupPositionsQuery("quote-1", "quote");
  assert.match(invoice, /order: invoice\(id: "inv-1"\)/);
  assert.match(quote, /order: quote\(id: "quote-1"\)/);
  assert.match(invoice, /lineItemGroups\(first: 100\)/);
  assert.match(quote, /lineItemGroups\(first: 100\)/);
});

test("parseExtractedCalcResponse: accepts null AI text for an unspecified decoration", () => {
  assert.deepEqual(
    parseExtractedCalcResponse({
      quoteNumber: null,
      garmentStyle: "PC54",
      garmentColor: null,
      explicitGarmentCostPerPiece: null,
      explicitMarkup: null,
      sizes: [],
      decorations: [
        {
          location: null,
          method: "Screen print",
          colorCount: 2,
          details: null,
        },
      ],
      uncertainties: [null, "Decoration location was not specified."],
    }),
    {
      quoteNumber: null,
      garmentStyle: "PC54",
      garmentColor: null,
      explicitGarmentCostPerPiece: null,
      explicitMarkup: null,
      sizes: [],
      decorations: [
        {
          location: null,
          method: "Screen print",
          colorCount: 2,
          details: null,
        },
      ],
      uncertainties: ["Decoration location was not specified."],
    },
  );
});
import {
  resolveStandardSizeGarmentPricing,
} from "../src/lib/hub/pricingProductResolver.ts";

function pricingVendor(
  vendor: "sanmar" | "ss",
  matchType: "exact" | "closest",
  colors: Array<{
    colorName: string;
    sizes: Array<{
      size: string;
      cost: number | null;
      salePrice: number | null;
      saleEndsAt?: string | null;
    }>;
  }>,
) {
  return {
    aliasUsed: null,
    lookup: {
      found: true,
      matchType,
      vendor,
      styleQueried: "PC54",
      styleId: vendor === "ss" ? "123" : null,
      styleName: "PC54",
      brand: "Port & Company",
      title: "Core Cotton Tee",
      styleImage: null,
      colors: colors.map((color) => ({
        colorName: color.colorName,
        swatchImage: null,
        productImage: null,
        sizes: color.sizes.map((size) => ({
          ...size,
          sku: null,
          inventoryKey: null,
          sizeIndex: null,
          msrp: null,
          saleEndsAt:
            size.salePrice === null
              ? null
              : (size.saleEndsAt ?? "2026-09-01"),
          inventoryTotal: null,
          warehouses: null,
        })),
      })),
      cached: false,
      fetchedAt: "2026-08-23T00:00:00.000Z",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// AI calculator vendor pricing — standard sizes only, no size list required
// ─────────────────────────────────────────────────────────────────────────

test("resolveStandardSizeGarmentPricing: uses active sale from XS–XL and ignores plus sizes", () => {
  const result = resolveStandardSizeGarmentPricing(
    {
      vendors: [
        pricingVendor("sanmar", "exact", [
          {
            colorName: "Jet Black",
            sizes: [
              { size: "S", cost: 3, salePrice: 2.44 },
              { size: "XL", cost: 3, salePrice: 2.44 },
              { size: "4XL", cost: 1, salePrice: 0.5 },
            ],
          },
        ]),
      ],
    },
    "PC54",
    "Jet Black",
    new Date("2026-08-23T12:00:00.000Z"),
  );

  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.equal(result.cost, 2.44);
  assert.equal(result.match.regularCost, 3);
  assert.equal(result.match.saleCost, 2.44);
  assert.equal(result.match.appliedPriceType, "sale");
});

test("resolveStandardSizeGarmentPricing: ignores an expired dated sale", () => {
  const result = resolveStandardSizeGarmentPricing(
    {
      vendors: [
        pricingVendor("sanmar", "exact", [
          {
            colorName: "Jet Black",
            sizes: [
              {
                size: "M",
                cost: 3,
                salePrice: 2.44,
                saleEndsAt: "2026-07-12",
              },
            ],
          },
        ]),
      ],
    },
    "PC54",
    "Jet Black",
    new Date("2026-08-23T12:00:00.000Z"),
  );

  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.equal(result.cost, 3);
  assert.equal(result.match.regularCost, 3);
  assert.equal(result.match.saleCost, null);
  assert.equal(result.match.appliedPriceType, "regular");
});

test("resolveStandardSizeGarmentPricing: ignores malformed and impossible sale dates", () => {
  for (const saleEndsAt of ["not-a-date", "2026-02-30"]) {
    const result = resolveStandardSizeGarmentPricing(
      {
        vendors: [
          pricingVendor("sanmar", "exact", [
            {
              colorName: "Jet Black",
              sizes: [
                {
                  size: "M",
                  cost: 3,
                  salePrice: 2.44,
                  saleEndsAt,
                },
              ],
            },
          ]),
        ],
      },
      "PC54",
      "Jet Black",
      new Date("2026-01-15T12:00:00.000Z"),
    );

    assert.equal(result.resolved, true);
    if (!result.resolved) continue;
    assert.equal(result.cost, 3, saleEndsAt);
    assert.equal(result.match.saleCost, null, saleEndsAt);
    assert.equal(result.match.appliedPriceType, "regular", saleEndsAt);
  }
});

test("resolveStandardSizeGarmentPricing: uses regular cost when no sale is active", () => {
  const result = resolveStandardSizeGarmentPricing(
    {
      vendors: [
        pricingVendor("ss", "exact", [
          {
            colorName: "Navy",
            sizes: [
              { size: "M", cost: 4.25, salePrice: null },
              { size: "2XL", cost: 6.5, salePrice: null },
            ],
          },
        ]),
      ],
    },
    "PC54",
    "Navy",
  );

  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.equal(result.cost, 4.25);
  assert.equal(result.match.regularCost, 4.25);
  assert.equal(result.match.saleCost, null);
  assert.equal(result.match.appliedPriceType, "regular");
});

test("resolveStandardSizeGarmentPricing: resolves without a color and reports the selected regular-size color", () => {
  const result = resolveStandardSizeGarmentPricing(
    {
      vendors: [
        pricingVendor("sanmar", "exact", [
          {
            colorName: "Plus Only",
            sizes: [{ size: "4XL", cost: 1, salePrice: null }],
          },
          {
            colorName: "Athletic Heather",
            sizes: [{ size: "M", cost: 3.5, salePrice: null }],
          },
        ]),
      ],
    },
    "PC54",
    null,
  );

  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.equal(result.match.colorName, "Athletic Heather");
  assert.match(result.warnings.join(" "), /No garment color was provided/i);
});

test("resolveStandardSizeGarmentPricing: exact vendor match wins over a cheaper closest match", () => {
  const result = resolveStandardSizeGarmentPricing(
    {
      vendors: [
        pricingVendor("sanmar", "exact", [
          {
            colorName: "Black",
            sizes: [{ size: "M", cost: 5, salePrice: null }],
          },
        ]),
        pricingVendor("ss", "closest", [
          {
            colorName: "Black",
            sizes: [{ size: "M", cost: 2, salePrice: null }],
          },
        ]),
      ],
    },
    "PC54",
    "Black",
  );

  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.equal(result.match.vendor, "sanmar");
  assert.equal(result.cost, 5);
});

test("resolveStandardSizeGarmentPricing: fails when only plus-size prices exist", () => {
  const result = resolveStandardSizeGarmentPricing(
    {
      vendors: [
        pricingVendor("sanmar", "exact", [
          {
            colorName: "Black",
            sizes: [{ size: "3XL", cost: 7.5, salePrice: 6 }],
          },
        ]),
      ],
    },
    "PC54",
    "Black",
  );

  assert.equal(result.resolved, false);
  if (result.resolved) return;
  assert.match(result.warning, /no regular-size \(XS–XL\) pricing/i);
});

// ─────────────────────────────────────────────────────────────────────────
// blockMarker
// ─────────────────────────────────────────────────────────────────────────

test("blockMarker: with quoteNumber and named range", () => {
  assert.equal(
    blockMarker("1234", "12-48"),
    "[Hub Price Calculator Q1234]",
  );
});

test("blockMarker: range does not change calculator block identity", () => {
  assert.equal(blockMarker("42", "all"), "[Hub Price Calculator Q42]");
  assert.equal(blockMarker("42", "12-48"), blockMarker("42", "144-288"));
});

test("blockMarker: requires a numeric quote identity", () => {
  assert.throws(() => blockMarker("", "all"), /quote number is required/i);
  assert.throws(() => blockMarker("Q42", "all"), /quote number is required/i);
});

// ─────────────────────────────────────────────────────────────────────────
// buildNoteBlock — QTY + Unit Price only, no totals
// ─────────────────────────────────────────────────────────────────────────

test("buildNoteBlock: formats rows as QTY + unit price only (no total)", () => {
  const block = buildNoteBlock("1234", "12-48", [
    { qty: 12, unitPrice: 15.5 },
    { qty: 24, unitPrice: 14.0 },
  ]);
  assert.match(block, /\[Hub Price Calculator Q1234\]/);
  assert.match(block, /Range: 12–48/);
  assert.match(block, /QTY\tUnit Price/);
  assert.match(block, /12\+\t\$15\.50/);
  assert.match(block, /24\+\t\$14\.00/);
  // Must NOT include a line containing "=" followed by a dollar amount (no totals)
  const lines = block.split("\n");
  for (const line of lines) {
    assert.ok(
      !line.match(/=\s*\$\d/),
      `Line should not contain a total amount: "${line}"`,
    );
  }
});

test("buildNoteBlock: closing marker mirrors opening marker", () => {
  const block = buildNoteBlock("99", "60-96", [{ qty: 60, unitPrice: 10 }]);
  assert.match(block, /\[Hub Price Calculator Q99\]/);
  assert.match(block, /\[\/Hub Price Calculator Q99\]/);
});

// ─────────────────────────────────────────────────────────────────────────
// spliceNoteBlock
// ─────────────────────────────────────────────────────────────────────────

test("spliceNoteBlock: appends block to empty note", () => {
  const block = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const result = spliceNoteBlock("", block, "1", "12-48");
  assert.equal(result, block);
});

test("spliceNoteBlock: appends block to existing unrelated note", () => {
  const block = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const result = spliceNoteBlock("Some notes here.", block, "1", "12-48");
  assert.ok(result.startsWith("Some notes here."));
  assert.ok(result.includes(block));
});

test("spliceNoteBlock: replaces existing block for the same quote", () => {
  const block1 = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const block2 = buildNoteBlock("1", "12-48", [{ qty: 24, unitPrice: 9 }]);
  const note = `Intro\n\n${block1}\n\nOutro`;
  const result = spliceNoteBlock(note, block2, "1", "12-48");
  assert.ok(!result.includes("12+\t$10.00"));
  assert.ok(result.includes("24+\t$9.00"));
  assert.ok(result.includes("Intro"));
  assert.ok(result.includes("Outro"));
});

test("spliceNoteBlock: changing range refreshes the same quote block", () => {
  const block1 = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const block2 = buildNoteBlock("1", "36-72", [{ qty: 36, unitPrice: 8 }]);
  const result = spliceNoteBlock(block1, block2, "1", "36-72");
  assert.ok(!result.includes("Range: 12–48"));
  assert.ok(result.includes("Range: 36–72"));
  assert.equal(result.match(/\[Hub Price Calculator Q1\]/g)?.length, 1);
});

test("spliceNoteBlock: does not replace a different quote block", () => {
  const block1 = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const block2 = buildNoteBlock("2", "36-72", [{ qty: 36, unitPrice: 8 }]);
  const result = spliceNoteBlock(block1, block2, "2", "36-72");
  assert.ok(result.includes("Hub Price Calculator Q1"));
  assert.ok(result.includes("Hub Price Calculator Q2"));
});

test("spliceNoteBlock: malformed unclosed block fails closed without truncating notes", () => {
  const block = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const malformed =
    "Intro\n\n[Hub Price Calculator Q1]\nRange: 12–48\nUser note after malformed block";
  assert.throws(
    () => spliceNoteBlock(malformed, block, "1", "12-48"),
    /unclosed Hub block.*No notes were changed/i,
  );
  assert.match(malformed, /User note after malformed block/);
});

test("spliceNoteBlock: unmatched closing marker fails closed", () => {
  const block = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const malformed = "Intro\n[/Hub Price Calculator Q1]\nOutro";
  assert.throws(
    () => spliceNoteBlock(malformed, block, "1", "12-48"),
    /unmatched Hub closing marker/i,
  );
});

test("spliceNoteBlock: duplicate complete same-quote blocks collapse deterministically", () => {
  const old1 = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  const old2 = buildNoteBlock("1", "36-72", [{ qty: 36, unitPrice: 8 }]);
  const fresh = buildNoteBlock("1", "60-96", [{ qty: 60, unitPrice: 7 }]);
  const note = `Intro\n\n${old1}\n\nKeep this text\n\n${old2}\n\nOutro`;
  const result = spliceNoteBlock(note, fresh, "1", "60-96");
  assert.equal(result.match(/\[Hub Price Calculator Q1\]/g)?.length, 1);
  assert.ok(result.includes("Keep this text"));
  assert.ok(result.includes("Intro"));
  assert.ok(result.includes("Outro"));
  assert.ok(result.includes("60+\t$7.00"));
  assert.ok(!result.includes("12+\t$10.00"));
  assert.ok(!result.includes("36+\t$8.00"));
});

// ─────────────────────────────────────────────────────────────────────────
// noteContainsBlock
// ─────────────────────────────────────────────────────────────────────────

test("noteContainsBlock: returns true when block is present", () => {
  const block = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  assert.ok(noteContainsBlock(`Intro\n\n${block}\n\nOutro`, block));
});

test("noteContainsBlock: returns false when block absent", () => {
  const block = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  assert.ok(!noteContainsBlock("Unrelated content", block));
});

test("noteContainsBlock: returns false for null note", () => {
  const block = buildNoteBlock("1", "12-48", [{ qty: 12, unitPrice: 10 }]);
  assert.ok(!noteContainsBlock(null, block));
});

// ─────────────────────────────────────────────────────────────────────────
// priceRowsEqual
// ─────────────────────────────────────────────────────────────────────────

test("priceRowsEqual: equal rows (same order)", () => {
  assert.ok(
    priceRowsEqual(
      [{ qty: 12, unitPrice: 10 }, { qty: 24, unitPrice: 9 }],
      [{ qty: 12, unitPrice: 10 }, { qty: 24, unitPrice: 9 }],
    ),
  );
});

test("priceRowsEqual: equal rows (different order)", () => {
  assert.ok(
    priceRowsEqual(
      [{ qty: 24, unitPrice: 9 }, { qty: 12, unitPrice: 10 }],
      [{ qty: 12, unitPrice: 10 }, { qty: 24, unitPrice: 9 }],
    ),
  );
});

test("priceRowsEqual: different lengths", () => {
  assert.ok(
    !priceRowsEqual(
      [{ qty: 12, unitPrice: 10 }],
      [{ qty: 12, unitPrice: 10 }, { qty: 24, unitPrice: 9 }],
    ),
  );
});

test("priceRowsEqual: same qty different price", () => {
  assert.ok(!priceRowsEqual([{ qty: 12, unitPrice: 10 }], [{ qty: 12, unitPrice: 11 }]));
});

// ─────────────────────────────────────────────────────────────────────────
// validatePriceRows — range key validation
// ─────────────────────────────────────────────────────────────────────────

test("VALID_RANGE_KEYS: contains exactly the 7 valid keys", () => {
  const expected = new Set(["all", "12-48", "36-72", "60-96", "84-120", "108-144", "144-288"]);
  assert.deepEqual(VALID_RANGE_KEYS, expected);
});

test("validatePriceRows: valid rows for 12-48 range", () => {
  assert.equal(
    validatePriceRows(
      [{ qty: 12, unitPrice: 15 }, { qty: 24, unitPrice: 14 }, { qty: 48, unitPrice: 13 }],
      "12-48",
    ),
    null,
  );
});

test("validatePriceRows: all range accepts any positive qty", () => {
  assert.equal(
    validatePriceRows([{ qty: 1, unitPrice: 100 }, { qty: 500, unitPrice: 5 }], "all"),
    null,
  );
});

test("validatePriceRows: all valid range keys accepted with minimum qty", () => {
  for (const key of VALID_RANGE_KEYS) {
    const qty = key === "all" ? 1 : Number(key.split("-")[0]);
    const err = validatePriceRows([{ qty, unitPrice: 10 }], key);
    assert.equal(err, null, `Expected null for rangeKey="${key}"`);
  }
});

test("validatePriceRows: all valid range keys accepted with maximum qty", () => {
  for (const key of VALID_RANGE_KEYS) {
    if (key === "all") continue; // no upper bound for "all"
    const qty = Number(key.split("-")[1]);
    const err = validatePriceRows([{ qty, unitPrice: 10 }], key);
    assert.equal(err, null, `Expected null at upper bound for rangeKey="${key}"`);
  }
});

test("validatePriceRows: qty below range lower bound rejected", () => {
  const err = validatePriceRows([{ qty: 6, unitPrice: 20 }], "12-48");
  assert.ok(err !== null && err.match(/outside the range/));
});

test("validatePriceRows: qty above range upper bound rejected", () => {
  const err = validatePriceRows([{ qty: 50, unitPrice: 10 }], "12-48");
  assert.ok(err !== null && err.match(/outside the range/));
});

test("validatePriceRows: duplicate qty rejected", () => {
  const err = validatePriceRows(
    [{ qty: 12, unitPrice: 10 }, { qty: 12, unitPrice: 9 }],
    "12-48",
  );
  assert.ok(err !== null && err.match(/duplicate qty/));
});

test("validatePriceRows: rows not sorted ascending rejected", () => {
  const err = validatePriceRows(
    [{ qty: 24, unitPrice: 9 }, { qty: 12, unitPrice: 10 }],
    "12-48",
  );
  assert.ok(err !== null && err.match(/sorted ascending/));
});

test("validatePriceRows: negative unit price rejected", () => {
  const err = validatePriceRows([{ qty: 12, unitPrice: -1 }], "12-48");
  assert.ok(err !== null && err.match(/unitPrice/));
});

test("validatePriceRows: non-integer qty rejected", () => {
  const err = validatePriceRows([{ qty: 12.5, unitPrice: 10 }], "12-48");
  assert.ok(err !== null && err.match(/positive integer/));
});

test("validatePriceRows: empty rows rejected", () => {
  const err = validatePriceRows([], "12-48");
  assert.ok(err !== null && err.match(/empty/));
});

test("validatePriceRows: invalid rangeKey rejected", () => {
  const err = validatePriceRows([{ qty: 12, unitPrice: 10 }], "bad-key");
  assert.ok(err !== null && err.match(/rangeKey/));
});

// ─────────────────────────────────────────────────────────────────────────
// computeDedupeKey
// ─────────────────────────────────────────────────────────────────────────

test("computeDedupeKey: same inputs produce same hash", () => {
  const opts = {
    invoiceId: "inv-abc",
    visualId: 1234,
    quoteNumber: "99",
    rangeKey: "12-48",
    priceRows: [{ qty: 12, unitPrice: 10 }, { qty: 24, unitPrice: 9 }],
  };
  assert.equal(computeDedupeKey(opts), computeDedupeKey(opts));
});

test("computeDedupeKey: row order does not affect hash (canonical sort)", () => {
  const a = computeDedupeKey({
    invoiceId: "inv-abc",
    visualId: 1234,
    quoteNumber: null,
    rangeKey: "12-48",
    priceRows: [{ qty: 24, unitPrice: 9 }, { qty: 12, unitPrice: 10 }],
  });
  const b = computeDedupeKey({
    invoiceId: "inv-abc",
    visualId: 1234,
    quoteNumber: null,
    rangeKey: "12-48",
    priceRows: [{ qty: 12, unitPrice: 10 }, { qty: 24, unitPrice: 9 }],
  });
  assert.equal(a, b);
});

test("computeDedupeKey: different invoiceId → different hash", () => {
  const base = {
    invoiceId: "inv-abc",
    visualId: 1234,
    quoteNumber: null,
    rangeKey: "12-48",
    priceRows: [{ qty: 12, unitPrice: 10 }],
  };
  assert.notEqual(
    computeDedupeKey(base),
    computeDedupeKey({ ...base, invoiceId: "inv-xyz" }),
  );
});

test("computeDedupeKey: different priceRows → different hash", () => {
  const base = {
    invoiceId: "inv-abc",
    visualId: 1234,
    quoteNumber: null,
    rangeKey: "12-48",
    priceRows: [{ qty: 12, unitPrice: 10 }],
  };
  assert.notEqual(
    computeDedupeKey(base),
    computeDedupeKey({ ...base, priceRows: [{ qty: 12, unitPrice: 11 }] }),
  );
});

test("computeDedupeKey: quoteNumber=null vs quoteNumber='x' differ", () => {
  const base = {
    invoiceId: "inv-abc",
    visualId: 1234,
    rangeKey: "12-48",
    priceRows: [{ qty: 12, unitPrice: 10 }],
  };
  assert.notEqual(
    computeDedupeKey({ ...base, quoteNumber: null }),
    computeDedupeKey({ ...base, quoteNumber: "x" }),
  );
});

test("computeDedupeKey: returns 64-char hex SHA-256", () => {
  const key = computeDedupeKey({
    invoiceId: "x",
    visualId: 1,
    quoteNumber: null,
    rangeKey: "all",
    priceRows: [{ qty: 1, unitPrice: 1 }],
  });
  assert.match(key, /^[0-9a-f]{64}$/);
});

// ─────────────────────────────────────────────────────────────────────────
// sanitizeFilename
// ─────────────────────────────────────────────────────────────────────────

test("sanitizeFilename: removes path separators and dangerous characters", () => {
  const s = sanitizeFilename("../../../etc/passwd");
  // Forward slashes are stripped (replaced with dashes) — no directory traversal via URL
  assert.doesNotMatch(s, /\//);
  // The result is a flat filename token with no slashes
  assert.match(s, /^[A-Za-z0-9._-]+$/);
});

test("sanitizeFilename: preserves allowed chars", () => {
  assert.equal(sanitizeFilename("hub-calc-Q1234-abcd1234.png"), "hub-calc-Q1234-abcd1234.png");
});

// ─────────────────────────────────────────────────────────────────────────
// invoiceByIdQuery + invoiceUpdateMutation
// ─────────────────────────────────────────────────────────────────────────

test("invoiceByIdQuery: builds a valid query string", () => {
  const q = invoiceByIdQuery("abc123");
  assert.match(q, /query/);
  assert.match(q, /invoice/);
  assert.match(q, /"abc123"/);
  assert.match(q, /productionNote/);
  assert.match(q, /visualId/);
});

test("invoiceUpdateMutation: builds mutation with productionNote", () => {
  const m = invoiceUpdateMutation("inv-1", { productionNote: "Hello World" });
  assert.match(m, /mutation/);
  assert.match(m, /invoiceUpdate/);
  assert.match(m, /"Hello World"/);
  assert.match(m, /productionNote/);
});

test("invoiceUpdateMutation: throws on empty input", () => {
  assert.throws(() => invoiceUpdateMutation("inv-1", {}), /at least one field/);
});

test("invoiceUpdateMutation: JSON-escapes special characters in productionNote", () => {
  const m = invoiceUpdateMutation("inv-1", {
    productionNote: 'Say "hello" & done\n',
  });
  assert.match(m, /\\"/);
  assert.match(m, /\\n/);
});

// ─────────────────────────────────────────────────────────────────────────
// quoteByIdQuery + quoteUpdateMutation
// ─────────────────────────────────────────────────────────────────────────

test("quoteByIdQuery: builds a valid query string", () => {
  const q = quoteByIdQuery("quote-9");
  assert.match(q, /query/);
  assert.match(q, /quote\(/);
  assert.match(q, /"quote-9"/);
  assert.match(q, /productionNote/);
  assert.match(q, /visualId/);
});

test("quoteUpdateMutation: builds mutation with productionNote", () => {
  const m = quoteUpdateMutation("quote-9", { productionNote: "Hello Quote" });
  assert.match(m, /mutation/);
  assert.match(m, /quoteUpdate/);
  assert.match(m, /"Hello Quote"/);
  assert.match(m, /productionNote/);
});

test("quoteUpdateMutation: throws on empty input", () => {
  assert.throws(() => quoteUpdateMutation("quote-9", {}), /at least one field/);
});

test("quoteUpdateMutation: JSON-escapes special characters in productionNote", () => {
  const m = quoteUpdateMutation("quote-9", {
    productionNote: 'Say "hi" & done\n',
  });
  assert.match(m, /\\"/);
  assert.match(m, /\\n/);
});
