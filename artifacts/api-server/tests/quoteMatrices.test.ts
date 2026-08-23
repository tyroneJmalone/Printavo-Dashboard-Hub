import assert from "node:assert/strict";
import test from "node:test";
import { quoteCreateMutation } from "../../../lib/printavo/src/queries";
import {
  automaticMatrixColumnIndex,
  embroideryStitchTierIndex,
} from "../src/lib/quoteDrafts/embroideryStitchTiers";
import {
  parsePrintavoPricingMatrixReferences,
  PrintavoMatrixResolutionError,
  resolvePrintavoPricingColumns,
  type HubPricingMatrix,
  type PrintavoPricingMatrixReference,
} from "../src/lib/quoteDrafts/printavoMatrices";

const hubMatrices: HubPricingMatrix[] = [
  {
    id: "hub-screen",
    name: "1stPRINTLOC 2025",
    data: { xValues: [{ label: "1 color" }, { label: "2 color" }] },
  },
  {
    id: "hub-embroidery",
    name: "Embroidery",
    data: { xValues: [{ label: "0-5k" }, { label: "5K-6K" }] },
  },
];

const printavoMatrices: PrintavoPricingMatrixReference[] = [
  {
    id: "printavo-screen",
    name: "1st PRINT LOC - 2025",
    columns: [
      { id: "screen-1", columnName: "1 color" },
      { id: "screen-2", columnName: "2 color" },
    ],
  },
  {
    id: "printavo-embroidery",
    name: "Embroidery - 8",
    columns: [
      { id: "emb-0-5", columnName: "0-5k" },
      { id: "emb-5-6", columnName: "5K-6K" },
    ],
  },
];

test("maps embroidery stitch counts to their configured thousand-stitch tiers", () => {
  const columns = [
    { label: "0-5k" },
    { label: "5K-6K" },
    { label: "6k-7k" },
    { label: "10k-11k" },
    { label: "11k-12k" },
    { label: "12k-13k" },
  ];

  assert.equal(embroideryStitchTierIndex("Logo with 3k stitches", columns), 0);
  assert.equal(embroideryStitchTierIndex("5k stitches", columns), 1);
  assert.equal(embroideryStitchTierIndex("12K stitches", columns), 5);
  assert.equal(embroideryStitchTierIndex("stitch count: 12K", columns), 5);
  assert.equal(
    embroideryStitchTierIndex("12,000 stitches for the left chest", columns),
    5,
  );
  assert.equal(
    embroideryStitchTierIndex(
      "3k stitches on the front and 12k stitches on the back",
      columns,
    ),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("12K-13K stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("stitch count: 12K-13K", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("between 12,000 and 13,000 stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("12K or 13K stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("stitch count: 12K or 13K", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("12,000 or 13,000 stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("12K/13K stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("12K through 13K stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("up to 12K stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("under 12,000 stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("stitch count: at least 12K", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("12K stitches or less", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("approximately 12K stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("about 12,000 stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("~12K stitches", columns),
    null,
  );
  assert.equal(
    embroideryStitchTierIndex("12k stitches (12,000 stitches)", columns),
    5,
  );
  assert.equal(embroideryStitchTierIndex("9k stitches", columns), null);
  assert.equal(embroideryStitchTierIndex("3k shirts", columns), null);
  assert.equal(embroideryStitchTierIndex("3k MOQ", columns), null);
  assert.equal(embroideryStitchTierIndex("unqualified 3k", columns), null);
  assert.equal(embroideryStitchTierIndex("many stitches", columns), null);
  assert.equal(embroideryStitchTierIndex("stitch count unknown", columns), null);
  assert.equal(embroideryStitchTierIndex(null, columns), null);
});

test("never falls back to color-count columns for embroidery", () => {
  assert.equal(
    automaticMatrixColumnIndex(
      {
        method: "Embroidery",
        colorCount: 1,
        details: "stitch count unknown",
      },
      [{ label: "1 color" }, { label: "0-5k" }],
    ),
    null,
  );
});

test("resolves normalized screen-print and embroidery matrix identities", () => {
  const resolved = resolvePrintavoPricingColumns(
    [
      {
        id: "front",
        location: "Front",
        matrixId: "hub-screen",
        matrixColumnIndex: 1,
      },
      {
        id: "left-chest",
        location: "Left chest",
        matrixId: "hub-embroidery",
        matrixColumnIndex: 0,
      },
    ],
    hubMatrices,
    printavoMatrices,
  );

  assert.deepEqual(resolved, [
    { decorationId: "front", pricingMatrixColumnId: "screen-2" },
    { decorationId: "left-chest", pricingMatrixColumnId: "emb-0-5" },
  ]);
});

test("blocks missing and ambiguous Printavo matrix mappings", () => {
  const decoration = [{
    id: "front",
    location: "Front",
    matrixId: "hub-screen",
    matrixColumnIndex: 0,
  }];

  assert.throws(
    () => resolvePrintavoPricingColumns(decoration, hubMatrices, []),
    (err) =>
      err instanceof PrintavoMatrixResolutionError &&
      err.message.includes("no matching Printavo pricing matrix"),
  );
  assert.throws(
    () =>
      resolvePrintavoPricingColumns(
        decoration,
        hubMatrices,
        [printavoMatrices[0], { ...printavoMatrices[0], id: "duplicate" }],
      ),
    (err) =>
      err instanceof PrintavoMatrixResolutionError &&
      err.message.includes("matches more than one"),
  );
});

test("blocks missing, duplicated, and malformed matrix columns", () => {
  const decoration = [{
    id: "front",
    location: "Front",
    matrixId: "hub-screen",
    matrixColumnIndex: 0,
  }];

  assert.throws(
    () =>
      resolvePrintavoPricingColumns(
        decoration,
        hubMatrices,
        [{ ...printavoMatrices[0], columns: [] }],
      ),
    /column "1 color" is missing/,
  );
  assert.throws(
    () =>
      resolvePrintavoPricingColumns(
        decoration,
        hubMatrices,
        [{
          ...printavoMatrices[0],
          columns: [
            { id: "one", columnName: "1 color" },
            { id: "two", columnName: "1 COLOR" },
          ],
        }],
      ),
    /column "1 color" is duplicated/,
  );
  assert.throws(
    () =>
      parsePrintavoPricingMatrixReferences([{
        id: "matrix",
        name: "Matrix",
        columns: [{ id: " ", columnName: "1 color" }],
      }]),
    /column data is incomplete/,
  );
});

test("blocks an invalid Hub matrix selection", () => {
  assert.throws(
    () =>
      resolvePrintavoPricingColumns(
        [{
          id: "front",
          location: "Front",
          matrixId: "missing-hub-matrix",
          matrixColumnIndex: 0,
        }],
        hubMatrices,
        printavoMatrices,
      ),
    /select a valid Hub pricing matrix and column/,
  );
});

test("attaches the matrix column without changing the reviewed line price", () => {
  const mutation = quoteCreateMutation({
    contactId: "contact-1",
    customerDueAt: "2026-09-01",
    dueAt: "2026-09-01T17:00:00-04:00",
    nickname: "Matrix test",
    lineItemGroups: [{
      position: 1,
      lineItems: [{
        position: 1,
        itemNumber: "PC61",
        description: "Essential Tee",
        color: "Black",
        price: 21.4,
        markupPercentage: 200,
        sizes: [{ size: "size_l", count: 24 }],
      }],
      imprints: [{
        details: "Front — Screen print — 2 color",
        pricingMatrixColumnId: "screen-2",
      }],
    }],
  });

  assert.match(mutation, /price: 21\.40/);
  assert.match(
    mutation,
    /pricingMatrixColumn: \{ id: "screen-2" \}/,
  );
  assert.doesNotMatch(mutation, /imprints: \[[^\]]*(price|amount|cost):/);
});