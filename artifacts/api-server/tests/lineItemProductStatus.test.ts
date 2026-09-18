import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "pino";
import {
  BulkSetLineItemProductStatusBody,
} from "@workspace/api-zod";
import { lineItemUpdateMutation } from "@workspace/printavo";
import {
  bulkSetProductStatus,
  normalizeUniqueSelections,
  type ProductStatusDependencies,
  type ProductStatusSelection,
} from "../src/lib/purchasing/lineItemProductStatus";

const logger = {
  info() {},
  warn() {},
} as unknown as Logger;

interface MockOptions {
  liveStatus?: string | null;
  position?: number | null;
  member?: boolean;
  lock?: boolean;
  queryError?: boolean;
  mutateError?: boolean;
  mutationStatus?: string | null;
  reconcileStatus?: string | null;
}

function mockDeps(options: MockOptions = {}) {
  const documents = { queries: [] as string[], mutations: [] as string[] };
  let queryCount = 0;
  let confirmed: string | null | undefined;
  const deps: ProductStatusDependencies = {
    async query<T>(document: string): Promise<T> {
      documents.queries.push(document);
      queryCount += 1;
      if (options.queryError && queryCount === 1) throw new Error("network secret");
      const status =
        queryCount > 1 && "reconcileStatus" in options
          ? options.reconcileStatus
          : options.liveStatus ?? "need_ordering";
      return {
        lineItem: {
          id: "line-1",
          position: "position" in options ? options.position : 7,
          productStatus: status,
          // Deliberately no product, item number, color, sizes, quantity, or cost.
        },
      } as T;
    },
    async mutate<T>(document: string): Promise<T> {
      documents.mutations.push(document);
      if (options.mutateError) throw new Error("ambiguous network secret");
      return {
        lineItemUpdate: {
          id: "line-1",
          productStatus:
            "mutationStatus" in options ? options.mutationStatus : "ordered",
        },
      } as T;
    },
    async withItemLock<T>(
      _lineItemId: string,
      _orderId: string,
      work: Parameters<ProductStatusDependencies["withItemLock"]>[2],
    ): Promise<{ acquired: boolean; value?: T }> {
      if (options.lock === false) return { acquired: false };
      const value = await work(
        options.member === false
          ? null
          : {
              orderType: "invoice",
              visualId: 10,
              mirrorStatus: "need_ordering",
              async confirm(status) {
                confirmed = status;
                return true;
              },
            },
      );
      return { acquired: true, value: value as T };
    },
    async refreshOrder() {},
  };
  return { deps, documents, confirmed: () => confirmed };
}

const selection: ProductStatusSelection = {
  lineItemId: "line-1",
  orderId: "order-1",
};

test("query helper distinguishes explicit null from omitted status", () => {
  const unset = lineItemUpdateMutation("line-1", {
    position: 4,
    productStatus: null,
  });
  const omitted = lineItemUpdateMutation("line-1", { position: 4 });
  assert.match(unset, /position: 4, productStatus: null/);
  assert.match(omitted, /input: \{ position: 4 \}/);
  assert.doesNotMatch(omitted, /position: 4, productStatus:/);
});

test("all target values emit only live position and product status", async () => {
  for (const [target, expected] of [
    ["unset", "null"],
    ["ordered", "ordered"],
    ["received", "received"],
  ] as const) {
    const mock = mockDeps({
      mutationStatus: target === "unset" ? null : target,
    });
    const result = await bulkSetProductStatus(
      [selection],
      target,
      logger,
      mock.deps,
    );
    assert.equal(result.results[0]?.outcome, "updated");
    assert.equal(mock.documents.mutations.length, 1);
    assert.match(
      mock.documents.mutations[0]!,
      new RegExp(`input: \\{ position: 7, productStatus: ${expected} \\}`),
    );
    assert.doesNotMatch(
      mock.documents.mutations[0]!,
      /itemNumber|color|sizes|items|quantity|cost|invoiceUpdate|statusUpdate|purchaseOrder|productionFile|email/i,
    );
    assert.equal(mock.confirmed(), target === "unset" ? null : target);
  }
});

test("blank or missing product fields do not block an eligible update", async () => {
  const mock = mockDeps();
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.updated, 1);
});

test("request schema rejects invalid counts, ids, and statuses", () => {
  assert.equal(
    BulkSetLineItemProductStatusBody.safeParse({
      lineItems: [],
      status: "ordered",
    }).success,
    false,
  );
  assert.equal(
    BulkSetLineItemProductStatusBody.safeParse({
      lineItems: Array.from({ length: 6 }, (_, i) => ({
        lineItemId: `line-${i}`,
        orderId: "order-1",
      })),
      status: "ordered",
    }).success,
    false,
  );
  assert.equal(
    BulkSetLineItemProductStatusBody.safeParse({
      lineItems: [{ lineItemId: "", orderId: "order-1" }],
      status: "shipped",
    }).success,
    false,
  );
  assert.equal(
    normalizeUniqueSelections([
      { lineItemId: "line-1", orderId: "order-1" },
      { lineItemId: " line-1 ", orderId: "order-2" },
    ]),
    null,
    "duplicate line ids are rejected even if paired with different orders",
  );
});

test("unrelated order membership conflicts before any live call", async () => {
  const mock = mockDeps({ member: false });
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "conflict");
  assert.equal(mock.documents.queries.length, 0);
  assert.equal(mock.documents.mutations.length, 0);
});

test("stale live statuses conflict and are not overwritten", async () => {
  const mock = mockDeps({ liveStatus: "attached_to_po" });
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "conflict");
  assert.equal(mock.documents.mutations.length, 0);
});

test("already-target live status is reconciled without mutation", async () => {
  const mock = mockDeps({ liveStatus: "received" });
  const result = await bulkSetProductStatus(
    [selection],
    "received",
    logger,
    mock.deps,
  );
  assert.equal(result.alreadySet, 1);
  assert.equal(mock.documents.mutations.length, 0);
  assert.equal(mock.confirmed(), "received");
});

test("missing required live position fails closed", async () => {
  const mock = mockDeps({ position: null });
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "failed");
  assert.equal(mock.documents.mutations.length, 0);
});

test("unset is not falsely confirmed when the fresh read omits productStatus", async () => {
  const mock = mockDeps();
  mock.deps.query = async <T>(document: string) => {
    mock.documents.queries.push(document);
    return { lineItem: { id: "line-1", position: 7 } } as T;
  };
  const result = await bulkSetProductStatus(
    [selection],
    "unset",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "failed");
  assert.equal(mock.documents.mutations.length, 0);
});

test("unset remains unknown when mutation and reconciliation omit productStatus", async () => {
  const mock = mockDeps();
  let reads = 0;
  mock.deps.query = async <T>(document: string) => {
    mock.documents.queries.push(document);
    reads += 1;
    return {
      lineItem:
        reads === 1
          ? { id: "line-1", position: 7, productStatus: "need_ordering" }
          : { id: "line-1", position: 7 },
    } as T;
  };
  mock.deps.mutate = async <T>(document: string) => {
    mock.documents.mutations.push(document);
    return { lineItemUpdate: { id: "line-1" } } as T;
  };
  const result = await bulkSetProductStatus(
    [selection],
    "unset",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "unknown");
  assert.equal(mock.documents.mutations.length, 1);
  assert.equal(mock.documents.queries.length, 2);
});

test("unset omitted mutation result requires explicit-null reconciliation", async () => {
  const mock = mockDeps();
  let reads = 0;
  mock.deps.query = async <T>(document: string) => {
    mock.documents.queries.push(document);
    reads += 1;
    return {
      lineItem: {
        id: "line-1",
        position: 7,
        productStatus: reads === 1 ? "need_ordering" : null,
      },
    } as T;
  };
  mock.deps.mutate = async <T>(document: string) => {
    mock.documents.mutations.push(document);
    return { lineItemUpdate: { id: "line-1" } } as T;
  };
  const result = await bulkSetProductStatus(
    [selection],
    "unset",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "updated");
  assert.equal(mock.confirmed(), null);
});

test("partial batch counts updated, failed, conflict and unknown consistently", async () => {
  const variants = [
    mockDeps(),
    mockDeps({ queryError: true }),
    mockDeps({ liveStatus: "arrived" }),
    mockDeps({ mutateError: true, reconcileStatus: "need_ordering" }),
  ];
  let index = 0;
  let active = variants[0]!;
  const deps: ProductStatusDependencies = {
    query: (doc) => active.deps.query(doc),
    mutate: (doc) => active.deps.mutate(doc),
    refreshOrder: async () => {},
    async withItemLock(lineId, orderId, work) {
      active = variants[index++]!;
      return active.deps.withItemLock(lineId, orderId, work);
    },
  };
  const items = Array.from({ length: 4 }, (_, i) => ({
    lineItemId: `line-${i + 1}`,
    orderId: `order-${i + 1}`,
  }));
  // Each per-item mock expects line-1 in returned data. Adapt documents while
  // preserving the orchestration outcomes under test.
  for (let i = 1; i < variants.length; i++) {
    variants[i]!.deps.query = async <T>(doc: string) => {
      variants[i]!.documents.queries.push(doc);
      if (i === 1) throw new Error("read failed");
      return {
        lineItem: {
          id: items[i]!.lineItemId,
          position: 7,
          productStatus: i === 2 ? "arrived" : "need_ordering",
        },
      } as T;
    };
  }
  const result = await bulkSetProductStatus(items, "ordered", logger, deps);
  assert.equal(result.updated, 1);
  assert.equal(result.alreadySet, 0);
  assert.equal(result.failed, 3);
  assert.deepEqual(
    result.results.map((r) => r.outcome),
    ["updated", "failed", "conflict", "unknown"],
  );
});

test("ambiguous mutation is reconciled read-only and never retried", async () => {
  const mock = mockDeps({
    mutateError: true,
    reconcileStatus: "ordered",
  });
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "updated");
  assert.equal(mock.documents.mutations.length, 1);
  assert.equal(mock.documents.queries.length, 2);
});

test("a local mirror write failure never misreports confirmed Printavo success", async () => {
  const mock = mockDeps();
  const originalLock = mock.deps.withItemLock;
  mock.deps.withItemLock = (lineId, orderId, work) =>
    originalLock(lineId, orderId, async (mirror) =>
      work(
        mirror && {
          ...mirror,
          async confirm() {
            throw new Error("local database unavailable");
          },
        },
      ),
    );
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.updated, 1);
  assert.match(result.results[0]!.message, /Printavo updated/);
  assert.equal(mock.documents.mutations.length, 1);
});

test("already-set remains already_set when the local mirror write fails", async () => {
  const mock = mockDeps({ liveStatus: "ordered" });
  const originalLock = mock.deps.withItemLock;
  mock.deps.withItemLock = (lineId, orderId, work) =>
    originalLock(lineId, orderId, async (mirror) =>
      work(
        mirror && {
          ...mirror,
          async confirm() {
            throw new Error("local database unavailable");
          },
        },
      ),
    );
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.alreadySet, 1);
  assert.match(result.results[0]!.message, /already set/);
  assert.equal(mock.documents.mutations.length, 0);
});

test("full detail refresh is deduplicated and does not block the response", async () => {
  const mock = mockDeps();
  let refreshCalls = 0;
  mock.deps.refreshOrder = async () => {
    refreshCalls += 1;
    await new Promise<void>(() => {});
  };
  const result = await bulkSetProductStatus(
    [selection, { lineItemId: "line-2", orderId: "order-1" }],
    "ordered",
    logger,
    {
      ...mock.deps,
      query: async <T>(document: string) => {
        mock.documents.queries.push(document);
        const id = document.includes('"line-2"') ? "line-2" : "line-1";
        return {
          lineItem: { id, position: 7, productStatus: "need_ordering" },
        } as T;
      },
      mutate: async <T>(document: string) => {
        mock.documents.mutations.push(document);
        const id = document.includes('"line-2"') ? "line-2" : "line-1";
        return { lineItemUpdate: { id, productStatus: "ordered" } } as T;
      },
    },
  );
  assert.equal(result.updated, 2);
  assert.equal(refreshCalls, 0, "refresh must not start before the batch resolves");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1, "same-order refreshes are deduplicated");
});

test("lock conflict performs no query or mutation", async () => {
  const mock = mockDeps({ lock: false });
  const result = await bulkSetProductStatus(
    [selection],
    "ordered",
    logger,
    mock.deps,
  );
  assert.equal(result.results[0]?.outcome, "conflict");
  assert.equal(mock.documents.queries.length, 0);
  assert.equal(mock.documents.mutations.length, 0);
});