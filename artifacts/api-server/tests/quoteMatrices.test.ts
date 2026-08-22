import assert from "node:assert/strict";
import test from "node:test";
import { quoteCreateMutation } from "../../../lib/printavo/src/queries";
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