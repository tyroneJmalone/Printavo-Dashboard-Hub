import assert from "node:assert/strict";
import test from "node:test";
import {
  compareLineItemSnapshots,
  isCompleteOrderDetail,
  isFetchedObservationStale,
  lineItemHistoryHash,
  type LineItemHistoryState,
} from "../src/lib/sync/lineItemHistory.ts";

function item(
  id: string,
  overrides: Partial<LineItemHistoryState> = {},
): LineItemHistoryState {
  return {
    lineItemId: id,
    groupId: "group-1",
    position: 0,
    itemNumber: "PC61",
    color: "Red",
    description: "Classic tee",
    product: {
      id: "product-1",
      brand: "Gildan",
      itemNumber: "PC61",
      categoryId: "cat-1",
      categoryName: "T-Shirts",
    },
    quantity: { items: 12, sizes: [{ size: "M", count: 12 }] },
    unitPrice: "8.00",
    merch: false,
    productStatus: "ordered",
    ...overrides,
  };
}

test("first complete response establishes a baseline without additions", () => {
  assert.deepEqual(compareLineItemSnapshots([], [item("line-1")], true), []);
});

test("unchanged and reordered line items do not create history", () => {
  const first = [item("line-1"), item("line-2")];
  const reordered = [
    { ...item("line-2"), groupId: "group-2", position: 4 },
    { ...item("line-1"), groupId: "group-3", position: 2 },
  ];
  assert.equal(lineItemHistoryHash(first), lineItemHistoryHash(reordered));
  assert.deepEqual(compareLineItemSnapshots(first, reordered), []);
});

test("line additions and removals use stable upstream line ids", () => {
  const changes = compareLineItemSnapshots([item("line-1")], [item("line-2")]);
  assert.deepEqual(
    changes.map((change) => [change.kind, change.lineItemId]),
    [
      ["removed", "line-1"],
      ["added", "line-2"],
    ],
  );
});

test("quantity changes include size quantities", () => {
  const changes = compareLineItemSnapshots(
    [item("line-1")],
    [
      item("line-1", {
        quantity: {
          items: 14,
          sizes: [
            { size: "M", count: 10 },
            { size: "L", count: 4 },
          ],
        },
      }),
    ],
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.field, "quantity");
  assert.deepEqual(changes[0]?.oldValue, {
    items: 12,
    sizes: [{ size: "M", count: 12 }],
  });
  assert.deepEqual(changes[0]?.newValue, {
    items: 14,
    sizes: [
      { size: "M", count: 10 },
      { size: "L", count: 4 },
    ],
  });
});

test("price and identifying fields are compared independently", () => {
  const changes = compareLineItemSnapshots(
    [item("line-1")],
    [
      item("line-1", {
        unitPrice: "9.50",
        description: "Heavy tee",
        color: "Navy",
        product: {
          id: "product-2",
          brand: "Gildan",
          itemNumber: "PC61LS",
          categoryId: "cat-1",
          categoryName: "T-Shirts",
        },
      }),
    ],
  );
  assert.deepEqual(
    changes.map((change) => change.field),
    ["unitPrice", "description", "product", "color"],
  );
});

test("truncated detail responses are not complete observations", () => {
  const node = {
    id: "order-1",
    visualId: 1,
    totalQuantity: 1,
    timestamps: { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    lineItemGroups: {
      nodes: [
        {
          id: "group-1",
          position: 0,
          lineItems: {
            nodes: [],
            pageInfo: { hasNextPage: true },
          },
          imprints: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  assert.equal(isCompleteOrderDetail(node), false);
  assert.deepEqual(
    compareLineItemSnapshots([item("line-1")], [], true),
    [],
    "partial responses must not be treated as removals or a baseline",
  );
});

test("a late response cannot supersede a newer fetch-start fence", () => {
  const newer = new Date("2026-01-01T00:00:02Z");
  assert.equal(
    isFetchedObservationStale(new Date("2026-01-01T00:00:01Z"), newer),
    true,
  );
  assert.equal(
    isFetchedObservationStale(new Date("2026-01-01T00:00:03Z"), newer),
    false,
  );
  assert.equal(isFetchedObservationStale(newer, null), false);
});
