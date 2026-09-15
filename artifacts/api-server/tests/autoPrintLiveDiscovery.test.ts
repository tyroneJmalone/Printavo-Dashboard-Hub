import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverLiveAutoPrintOrders,
  fetchLiveOrderStatus,
  LiveDiscoveryError,
  liveOrderStatusMatches,
  type LiveOrderQueryClient,
} from "../src/lib/printQueue/autoPrint/liveDiscovery.ts";
import { scheduledAutoPrintAllowed } from "../src/lib/printQueue/autoPrint/schedulerSafety.ts";
import { checkPrintSafety } from "../src/lib/printQueue/autoPrint/printSafety.ts";
import { planAutoPrintDetails } from "../src/lib/printQueue/autoPrint/candidatePlanning.ts";
import type { PvOrderNode } from "@workspace/printavo";

const SOURCE_STATUS = "545161";
const OTHER_STATUS = "123";

function node(
  id: string,
  visualId: number,
  statusId = SOURCE_STATUS,
): PvOrderNode {
  return {
    id,
    visualId,
    nickname: `order-${visualId}`,
    total: null,
    subtotal: null,
    amountPaid: null,
    amountOutstanding: null,
    customerDueAt: null,
    invoiceAt: null,
    dueAt: null,
    paymentDueAt: null,
    publicUrl: null,
    workorderUrl: `https://shop.printavo.com/work_orders/${id}`,
    customerNote: null,
    productionNote: null,
    visualPoNumber: null,
    tags: null,
    status: { id: statusId, name: statusId === SOURCE_STATUS ? "Print Error - Review" : "Moved Out" },
    owner: null,
    contact: null,
    shippingAddress: null,
    billingAddress: null,
    deliveryMethod: null,
    paymentTerm: null,
    timestamps: {
      // This is intentionally old: live discovery must not apply an age
      // cutoff while looking for a newly statused invoice.
      createdAt: "2025-07-22T00:00:00Z",
      updatedAt: "2026-09-15T00:00:00Z",
    },
  };
}

class FakeClient implements LiveOrderQueryClient {
  readonly queries: string[] = [];
  private readonly pages: Record<string, unknown[]>;
  private readonly failure?: Error;

  constructor(pages: Record<string, unknown[]>, failure?: Error) {
    this.pages = pages;
    this.failure = failure;
  }

  async query<T>(query: string): Promise<T> {
    this.queries.push(query);
    if (this.failure) throw this.failure;
    const kind = query.includes("invoices(") ? "invoices" : "quotes";
    const after = query.match(/after: "([^"]+)"/)?.[1] ?? "first";
    const page = this.pages[`${kind}:${after}`] ?? {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    return { [kind]: page } as T;
  }
}

test("status-scoped live discovery finds an old invoice and never uses local status", async () => {
  const oldInvoice = {
    ...node("old-live-invoice", 18371),
    visualId: "18371",
  } as unknown as PvOrderNode;
  const client = new FakeClient({
    "invoices:first": {
      nodes: [oldInvoice],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });

  const result = await discoverLiveAutoPrintOrders([SOURCE_STATUS], client);

  assert.deepEqual(
    result.orders.map((order) => order.node.id),
    ["old-live-invoice"],
  );
  assert.equal(result.orders[0]?.node.visualId, 18371);
  assert.ok(client.queries[0]?.includes('statusIds: ["545161"]'));
  assert.ok(!client.queries[0]?.includes("inProductionAfter"));
  assert.ok(!client.queries[0]?.includes("inProductionBefore"));
  assert.ok(!client.queries[0]?.includes("updatedAfter"));
});

test("a moved-out local candidate is absent from the live set", async () => {
  const client = new FakeClient({
    "invoices:first": {
      // The old local row is deliberately not returned by the live
      // status-scoped connection after it moved out of the source status.
      nodes: [node("still-live", 10)],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });

  const result = await discoverLiveAutoPrintOrders([SOURCE_STATUS], client);

  assert.deepEqual(
    result.orders.map((order) => order.node.id),
    ["still-live"],
  );
  assert.ok(
    !result.orders.some((order) => order.node.status?.id === OTHER_STATUS),
  );
});

test("pagination is complete and duplicate visual ids remain one deduped candidate", async () => {
  const client = new FakeClient({
    "invoices:first": {
      nodes: [node("invoice-18371", 18371)],
      pageInfo: { hasNextPage: true, endCursor: "invoice-next" },
    },
    "invoices:invoice-next": {
      nodes: [node("invoice-2", 2)],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    "quotes:first": {
      nodes: [node("quote-18371", 18371)],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });

  const result = await discoverLiveAutoPrintOrders([SOURCE_STATUS], client);

  assert.equal(result.pages.invoices, 2);
  assert.equal(result.pages.quotes, 1);
  assert.deepEqual(
    result.orders.map((order) => order.node.id),
    ["invoice-2", "invoice-18371"],
  );
  assert.ok(client.queries[0]?.includes("sortDescending: false"));
});

test("incomplete pagination fails closed before any print-capable phase", async () => {
  const client = new FakeClient({
    "invoices:first": {
      nodes: [node("old-live-invoice", 18371)],
      pageInfo: { hasNextPage: true, endCursor: null },
    },
  });

  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client),
    (err: unknown) =>
      err instanceof LiveDiscoveryError &&
      err.kind === "incomplete_pagination" &&
      err.message.includes("incomplete"),
  );
});

test("pagination cursor A-B-A cycle fails closed", async () => {
  const client = new FakeClient({
    "invoices:first": {
      nodes: [node("page-a", 1)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
    },
    "invoices:cursor-a": {
      nodes: [node("page-b", 2)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-b" },
    },
    "invoices:cursor-b": {
      nodes: [node("page-a-again", 3)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
    },
  });

  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client),
    (err: unknown) =>
      err instanceof LiveDiscoveryError &&
      err.kind === "incomplete_pagination" &&
      err.message.includes("cycle"),
  );
});

test("rate/discovery failure fails closed rather than using cached candidates", async () => {
  const client = new FakeClient({}, new Error("Printavo rate limit hit twice"));

  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client),
    (err: unknown) =>
      err instanceof LiveDiscoveryError &&
      err.kind === "request" &&
      err.message.includes("rate limit"),
  );
});

test("unsupported status filtering reports options before any fallback crawl", async () => {
  const client = new FakeClient(
    {},
    new Error("Printavo GraphQL error: Unknown argument statusIds"),
  );

  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client),
    (err: unknown) =>
      err instanceof LiveDiscoveryError &&
      err.kind === "unsupported_filter" &&
      err.message.includes("before any fallback crawl"),
  );
});

test("development scheduler blocks live runs but permits dry runs and production", () => {
  assert.equal(scheduledAutoPrintAllowed(false, "development"), false);
  assert.equal(scheduledAutoPrintAllowed(true, "development"), true);
  assert.equal(scheduledAutoPrintAllowed(false, "production"), true);
});

test("PrintNode safety gate rejects invalid live status and failed checks", () => {
  let printNodeCalls = 0;
  const expected = {
    orderId: "18816529",
    visualId: 18371,
    sourceStatusId: SOURCE_STATUS,
  };
  const moved = {
    orderId: expected.orderId,
    visualId: expected.visualId,
    statusId: OTHER_STATUS,
    statusName: "Moved Out",
  };
  assert.equal(liveOrderStatusMatches(moved, expected), false);
  const invalid = checkPrintSafety({
    dryRun: false,
    observedStatus: moved,
    expected,
  });
  if (invalid.allowed) printNodeCalls += 1;
  assert.equal(invalid.allowed, false);
  assert.equal(printNodeCalls, 0);

  const failed = checkPrintSafety({
    dryRun: false,
    observedStatus: null,
    expected,
  });
  if (failed.allowed) printNodeCalls += 1;
  assert.equal(failed.allowed, false);
  assert.equal(printNodeCalls, 0);
});

test("exact status fence normalizes Printavo numeric-string visual ids", async () => {
  const client: LiveOrderQueryClient = {
    async query<T>() {
      return {
        invoice: {
          id: "18816529",
          visualId: "18371",
          status: { id: SOURCE_STATUS, name: "Print Error - Review" },
        },
      } as T;
    },
  };
  const observed = await fetchLiveOrderStatus("invoice", "18816529", client);
  assert.deepEqual(observed, {
    orderId: "18816529",
    visualId: 18371,
    statusId: SOURCE_STATUS,
    statusName: "Print Error - Review",
  });
});

test("dry-run safety gate never permits PrintNode even with matching live status", () => {
  const result = checkPrintSafety({
    dryRun: true,
    observedStatus: {
      orderId: "18816529",
      visualId: 18371,
      statusId: SOURCE_STATUS,
      statusName: "Print Error - Review",
    },
    expected: {
      orderId: "18816529",
      visualId: 18371,
      sourceStatusId: SOURCE_STATUS,
    },
  });
  assert.equal(result.allowed, false);
});

test("printed dedup and MAX cap select detail work before detail requests", () => {
  const live = [
    { orderId: "printed-id", visualId: 1 },
    { orderId: "old-2", visualId: 2 },
    { orderId: "old-3", visualId: 3 },
    { orderId: "old-4", visualId: 4 },
    { orderId: "converted-new-id", visualId: 5 },
  ];
  const plan = planAutoPrintDetails(
    live,
    (order) => order,
    new Set(["printed-id"]),
    new Set(["5"]),
    2,
  );
  const detailRequests = plan.selected.map((order) => order.orderId);
  assert.deepEqual(detailRequests, ["old-2", "old-3"]);
  assert.equal(plan.alreadyPrinted, 2);
  assert.equal(plan.deferred, 1);
});