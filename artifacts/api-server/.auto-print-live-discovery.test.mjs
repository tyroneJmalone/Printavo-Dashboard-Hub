// tests/autoPrintLiveDiscovery.test.ts
import assert from "node:assert/strict";
import test from "node:test";

// ../../lib/printavo/src/throttle.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var RequestGate = class {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
  }
  queue = Promise.resolve();
  lastRequestEndedAt = 0;
  schedule(fn) {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestEndedAt + this.minIntervalMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await fn();
      } finally {
        this.lastRequestEndedAt = Date.now();
      }
    });
    this.queue = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
};

// ../../lib/printavo/src/client.ts
var PRINTAVO_ENDPOINT = "https://www.printavo.com/api/v2";
var MIN_INTERVAL_MS = 620;
var RETRY_AFTER_429_MS = 5200;
var GRAPHQL_TIMEOUT_RETRY_DELAYS_MS = [5e3, 15e3, 3e4];
function isTransientTimeout(errors) {
  return errors.every(
    (e) => typeof e.message === "string" && e.message.startsWith("Timeout on")
  );
}
var NETWORK_RETRY_DELAYS_MS = [2e3, 6e3];
var PrintavoApiError = class extends Error {
  constructor(message, httpStatus, graphqlErrors, partialData) {
    super(message);
    this.httpStatus = httpStatus;
    this.graphqlErrors = graphqlErrors;
    this.partialData = partialData;
    this.name = "PrintavoApiError";
  }
};
var PrintavoClient = class {
  gate;
  endpoint;
  email;
  token;
  requestCount = 0;
  retryCount = 0;
  errorCount = 0;
  lastRequestAt = null;
  last429At = null;
  constructor(options) {
    this.email = options.email;
    this.token = options.token;
    this.endpoint = options.endpoint ?? PRINTAVO_ENDPOINT;
    this.gate = new RequestGate(options.minIntervalMs ?? MIN_INTERVAL_MS);
  }
  get stats() {
    return {
      requestCount: this.requestCount,
      retryCount: this.retryCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt?.toISOString() ?? null,
      last429At: this.last429At?.toISOString() ?? null
    };
  }
  /** All Printavo traffic must go through this method. */
  query(query, variables = {}) {
    return this.gate.schedule(() => this.execute(query, variables, true));
  }
  /**
   * Execute a non-idempotent GraphQL mutation exactly once.
   *
   * A connection drop after Printavo accepts a mutation can look identical to
   * a drop before it accepts it. Retrying in either this client or a caller
   * could create a duplicate quote/order, so writes intentionally get no 429,
   * timeout, or network retry. Callers must persist ambiguous outcomes for
   * operator review.
   */
  mutate(mutation, variables = {}) {
    return this.gate.schedule(() => this.execute(mutation, variables, false));
  }
  async execute(query, variables, allowRetry) {
    for (let timeoutAttempt = 0; ; timeoutAttempt++) {
      let response = allowRetry ? await this.postWithNetworkRetry(query, variables) : await this.postOnce(query, variables);
      if (response.status === 429) {
        if (!allowRetry) {
          this.last429At = /* @__PURE__ */ new Date();
          this.errorCount += 1;
          throw new PrintavoApiError(
            "Printavo rate limited a non-idempotent mutation; it was not retried",
            429
          );
        }
        this.last429At = /* @__PURE__ */ new Date();
        this.retryCount += 1;
        await sleep(RETRY_AFTER_429_MS);
        response = await this.postWithNetworkRetry(query, variables);
        if (response.status === 429) {
          this.errorCount += 1;
          throw new PrintavoApiError(
            "Printavo rate limit hit twice in a row (429 after cooldown retry)",
            429
          );
        }
      }
      if (!response.ok) {
        this.errorCount += 1;
        throw new PrintavoApiError(
          `Printavo HTTP ${response.status}: ${response.bodyText.slice(0, 500)}`,
          response.status
        );
      }
      let body;
      try {
        body = JSON.parse(response.bodyText);
      } catch {
        this.errorCount += 1;
        throw new PrintavoApiError(
          `Printavo returned invalid JSON: ${response.bodyText.slice(0, 200)}`,
          response.status
        );
      }
      if (body.errors && body.errors.length > 0) {
        if (allowRetry && isTransientTimeout(body.errors) && timeoutAttempt < GRAPHQL_TIMEOUT_RETRY_DELAYS_MS.length) {
          this.retryCount += 1;
          await sleep(GRAPHQL_TIMEOUT_RETRY_DELAYS_MS[timeoutAttempt]);
          continue;
        }
        this.errorCount += 1;
        const messages = body.errors.map((e) => e.message ?? JSON.stringify(e)).join("; ");
        throw new PrintavoApiError(
          `Printavo GraphQL error: ${messages}`,
          response.status,
          body.errors,
          body.data ?? void 0
        );
      }
      if (body.data === void 0 || body.data === null) {
        this.errorCount += 1;
        throw new PrintavoApiError(
          "Printavo returned no data",
          response.status
        );
      }
      return body.data;
    }
  }
  /**
   * fetch() (and body streaming) reject with TypeError ("fetch failed" /
   * "terminated") on connection-level failures (ECONNRESET, DNS blips).
   * These are transient — retry with backoff instead of failing the whole
   * sync run. The response body is fully buffered INSIDE the retried unit
   * because connection drops surface during body reads too, not just on
   * the initial fetch. GraphQL queries are read-only, so re-sending after
   * a partial exchange is safe.
   */
  async postWithNetworkRetry(query, variables) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.post(query, variables);
        const bodyText = await response.text();
        return { status: response.status, ok: response.ok, bodyText };
      } catch (err) {
        if (attempt >= NETWORK_RETRY_DELAYS_MS.length) {
          this.errorCount += 1;
          throw err;
        }
        this.retryCount += 1;
        await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  async postOnce(query, variables) {
    const response = await this.post(query, variables);
    const bodyText = await response.text();
    return { status: response.status, ok: response.ok, bodyText };
  }
  async post(query, variables) {
    this.requestCount += 1;
    this.lastRequestAt = /* @__PURE__ */ new Date();
    return fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        email: this.email,
        token: this.token
      },
      body: JSON.stringify({ query, variables })
    });
  }
};

// ../../lib/printavo/src/queries.ts
var PAGE_SIZE = 25;
function lit(value) {
  return JSON.stringify(value);
}
function afterArg(after) {
  return after ? `, after: ${lit(after)}` : "";
}
var ADDRESS_FIELDS = `
  customerName
  companyName
  address1
  address2
  city
  state
  stateIso
  zipCode
  country
`;
var ORDER_NODE_FIELDS = `
  id
  visualId
  nickname
  total
  subtotal
  amountPaid
  amountOutstanding
  customerDueAt
  invoiceAt
  dueAt
  paymentDueAt
  publicUrl
  workorderUrl
  customerNote
  productionNote
  visualPoNumber
  tags
  createdAt
  startAt
  discount
  discountAmount
  discountAsPercentage
  salesTax
  salesTaxAmount
  totalUntaxed
  totalQuantity
  paidInFull
  merch
  packingSlipUrl
  publicPdf
  publicHash
  url
  status { id name }
  owner { id email }
  contact { id fullName email customer { id companyName } }
  shippingAddress { ${ADDRESS_FIELDS} }
  billingAddress { ${ADDRESS_FIELDS} }
  deliveryMethod { id name archived }
  paymentTerm { id name days archived }
  timestamps { createdAt updatedAt }
`;
var PAGE_INFO = `pageInfo { hasNextPage endCursor }`;
function sortDescArg(sortDescending) {
  return sortDescending === false ? "false" : "true";
}
function statusIdsArg(statusIds) {
  if (!statusIds || statusIds.length === 0) return "";
  return `, statusIds: [${statusIds.map(lit).join(", ")}]`;
}
function invoicesPageQuery(args = {}) {
  return `query {
    invoices(first: ${PAGE_SIZE}${afterArg(args.after)}${statusIdsArg(args.statusIds)}, sortOn: VISUAL_ID, sortDescending: ${sortDescArg(args.sortDescending)}) {
      nodes { ${ORDER_NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }`;
}
function quotesPageQuery(args = {}) {
  return `query {
    quotes(first: ${PAGE_SIZE}${afterArg(args.after)}${statusIdsArg(args.statusIds)}, sortOn: VISUAL_ID, sortDescending: ${sortDescArg(args.sortDescending)}) {
      nodes { ${ORDER_NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }`;
}
function singleOrderStatusQuery(kind, printavoId) {
  return `query {
    ${kind}(id: ${lit(printavoId)}) {
      id
      visualId
      status { id name }
    }
  }`;
}
var EXTRAS_MOCKUPS_FIRST = 5;
var EXTRAS_CONNECTION_FIRST = 25;
var MOCKUP_FIELDS = `
  id
  fullImageUrl
  thumbnailUrl
  mimeType
  displayThumbnail
  timestamps { createdAt updatedAt }
`;
var EXTRAS_LINE_ITEM_FIELDS = `
  id
  position
  markupPercentage
  taxed
  personalizations { id name personalization }
  priceReceipt { defaultMarkupPercentage description price signature }
  product {
    id
    brand
    color
    description
    itemNumber
    catalog { id name }
  }
  poLineItem {
    id
    purchaseOrder {
      id
      visualPoId
      goodsStatus
      note
      vendor { id name company email accountNumber }
    }
  }
  mockups(first: ${EXTRAS_MOCKUPS_FIRST}) {
    nodes { ${MOCKUP_FIELDS} }
    pageInfo { hasNextPage }
  }
`;
var EXTRAS_IMPRINT_FIELDS = `
  id
  mockups(first: ${EXTRAS_MOCKUPS_FIRST}) {
    nodes { ${MOCKUP_FIELDS} }
    pageInfo { hasNextPage }
  }
`;
var EXTRAS_ORDER_CONNECTIONS = `
  fees(first: ${EXTRAS_CONNECTION_FIRST}) {
    nodes {
      id
      amount
      description
      quantity
      taxable
      unitPrice
      unitPriceAsPercentage
      timestamps { createdAt updatedAt }
    }
    ${PAGE_INFO}
  }
  expenses(first: ${EXTRAS_CONNECTION_FIRST}) {
    nodes {
      id
      name
      amount
      transactionAt
      userGenerated
      timestamps { createdAt updatedAt }
    }
    ${PAGE_INFO}
  }
  approvalRequests(first: ${EXTRAS_CONNECTION_FIRST}) {
    nodes {
      id
      name
      status
      requester { id name email }
      retractor { id name email }
      response { name email reason respondedAt }
      timestamps { createdAt updatedAt }
    }
    ${PAGE_INFO}
  }
  productionFiles(first: ${EXTRAS_CONNECTION_FIRST}) {
    nodes {
      id
      name
      fileUrl
      mimeType
      timestamps { createdAt updatedAt }
    }
    ${PAGE_INFO}
  }
  customAddresses(first: ${EXTRAS_CONNECTION_FIRST}) {
    nodes {
      id
      name
      customerName
      companyName
      address1
      address2
      city
      state
      stateIso
      zipCode
      country
      countryIso
      timestamps { createdAt updatedAt }
    }
    ${PAGE_INFO}
  }
  threadSummary { id unread }
  paymentRequest {
    id
    amount
    description
    nickname
    status
    requestedAt
    visualId
  }
  contractorProfile { id companyName email phone website logo }
`;
var MESSAGE_PARTICIPANT = `
  __typename
  ... on Contact { id fullName email }
  ... on User { id name email }
`;
var MESSAGE_COMMON_FIELDS = `
  id
  from
  to
  incoming
  status
  text
  sender { ${MESSAGE_PARTICIPANT} }
  recipient { ${MESSAGE_PARTICIPANT} }
  attachments(first: 25) {
    nodes { filename url }
    pageInfo { hasNextPage }
  }
  timestamps { createdAt updatedAt }
`;

// src/lib/printavoGateway.ts
var client = null;
function getPrintavoClient() {
  if (!client) {
    const email = process.env["PRINTAVO_API_EMAIL"];
    const token = process.env["PRINTAVO_API_TOKEN"];
    if (!email || !token) {
      throw new Error(
        "PRINTAVO_API_EMAIL and PRINTAVO_API_TOKEN must be set to talk to Printavo"
      );
    }
    client = new PrintavoClient({ email, token });
  }
  return client;
}

// src/lib/printQueue/autoPrint/liveDiscovery.ts
var LiveDiscoveryError = class extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
    this.name = "LiveDiscoveryError";
  }
};
function normalizeVisualId(raw) {
  const visualId = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(visualId) ? visualId : null;
}
async function fetchLiveOrderStatus(kind, orderId, client2 = getPrintavoClient()) {
  const data = await client2.query(
    singleOrderStatusQuery(kind, orderId)
  );
  const node2 = data[kind] ?? null;
  if (!node2) return null;
  return {
    orderId: node2.id,
    visualId: normalizeVisualId(node2.visualId),
    statusId: node2.status?.id ?? null,
    statusName: node2.status?.name ?? null
  };
}
function liveOrderStatusMatches(observed, expected) {
  return observed !== null && observed.orderId === expected.orderId && observed.visualId === expected.visualId && observed.statusId === expected.sourceStatusId;
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function isUnsupportedStatusFilter(err) {
  const message = errorMessage(err).toLowerCase();
  return message.includes("statusids") && (message.includes("unknown argument") || message.includes("argument") || message.includes("field") || message.includes("cannot query"));
}
function unsupportedFilterError(err) {
  return new LiveDiscoveryError(
    [
      "Printavo does not support status-scoped live discovery (statusIds)",
      "for this account/schema; auto-print was aborted before any fallback",
      "crawl. Verify the v2 schema or add a supported status filter before",
      "using an expensive historical workaround. Upstream error:",
      errorMessage(err)
    ].join(" "),
    "unsupported_filter"
  );
}
function invalidResponse(kind, page, reason) {
  return new LiveDiscoveryError(
    `Live auto-print discovery returned an invalid ${kind} page ${page}: ${reason}`,
    "invalid_response"
  );
}
function readConnection(kind, data, page) {
  const key = kind === "invoices" ? "invoices" : "quotes";
  const connection = data?.[key];
  if (!connection || typeof connection !== "object") {
    throw invalidResponse(kind, page, `missing ${key} connection`);
  }
  const value = connection;
  if (!Array.isArray(value.nodes)) {
    throw invalidResponse(kind, page, "nodes is not an array");
  }
  if (!value.pageInfo || typeof value.pageInfo.hasNextPage !== "boolean" || value.pageInfo.endCursor !== null && typeof value.pageInfo.endCursor !== "string") {
    throw invalidResponse(kind, page, "pageInfo is incomplete");
  }
  return value;
}
async function discoverLiveAutoPrintOrders(statusIds, client2 = getPrintavoClient()) {
  const wantedStatuses = new Set(
    statusIds.filter((statusId) => statusId.trim().length > 0)
  );
  if (wantedStatuses.size === 0) {
    throw new LiveDiscoveryError(
      "Live auto-print discovery requires at least one source status",
      "invalid_response"
    );
  }
  const byVisual = /* @__PURE__ */ new Map();
  const pages = {
    invoices: 0,
    quotes: 0
  };
  for (const kind of ["invoices", "quotes"]) {
    let cursor = null;
    const seenCursors = /* @__PURE__ */ new Set();
    for (; ; ) {
      const pageNumber = pages[kind] + 1;
      let data;
      try {
        const query = kind === "invoices" ? invoicesPageQuery({
          after: cursor,
          statusIds: [...wantedStatuses],
          sortDescending: false
        }) : quotesPageQuery({
          after: cursor,
          statusIds: [...wantedStatuses],
          sortDescending: false
        });
        data = await client2.query(query);
      } catch (err) {
        if (isUnsupportedStatusFilter(err)) {
          throw unsupportedFilterError(err);
        }
        throw new LiveDiscoveryError(
          `Live auto-print discovery failed on ${kind} page ${pageNumber}: ${errorMessage(err)}`,
          "request"
        );
      }
      const page = readConnection(kind, data, pageNumber);
      pages[kind] = pageNumber;
      for (const rawNode of page.nodes) {
        if (!rawNode || typeof rawNode !== "object") {
          throw invalidResponse(kind, pageNumber, "a node is not an object");
        }
        const node2 = rawNode;
        if (typeof node2.id !== "string" || node2.id.length === 0) {
          throw invalidResponse(kind, pageNumber, "a node has no id");
        }
        const visualId = normalizeVisualId(
          node2.visualId
        );
        if (visualId === null) {
          throw invalidResponse(
            kind,
            pageNumber,
            `order ${node2.id} has no integer visualId`
          );
        }
        const normalizedNode = { ...node2, visualId };
        if (!node2.status || typeof node2.status.id !== "string" || !wantedStatuses.has(node2.status.id)) {
          throw invalidResponse(
            kind,
            pageNumber,
            `order ${node2.id} did not match the requested statusIds`
          );
        }
        const existing = byVisual.get(visualId);
        if (!existing || existing.kind === "quotes" && kind === "invoices") {
          byVisual.set(visualId, { kind, node: normalizedNode });
        }
      }
      if (!page.pageInfo.hasNextPage) break;
      const nextCursor = page.pageInfo.endCursor;
      if (!nextCursor) {
        throw new LiveDiscoveryError(
          `Live auto-print discovery was incomplete: ${kind} page ${pageNumber} reported hasNextPage without an endCursor`,
          "incomplete_pagination"
        );
      }
      if (nextCursor === cursor) {
        throw new LiveDiscoveryError(
          `Live auto-print discovery was incomplete: ${kind} page ${pageNumber} repeated its cursor`,
          "incomplete_pagination"
        );
      }
      if (seenCursors.has(nextCursor)) {
        throw new LiveDiscoveryError(
          `Live auto-print discovery was incomplete: ${kind} pagination cursor cycle detected at ${nextCursor}`,
          "incomplete_pagination"
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  return {
    orders: [...byVisual.values()].sort(
      (a, b) => a.node.visualId - b.node.visualId
    ),
    pages
  };
}

// src/lib/printQueue/autoPrint/schedulerSafety.ts
function scheduledAutoPrintAllowed(dryRun, nodeEnv = process.env.NODE_ENV) {
  return nodeEnv !== "development" || dryRun;
}

// src/lib/printQueue/autoPrint/printSafety.ts
function checkPrintSafety(input) {
  if (input.dryRun) {
    return { allowed: false, reason: "Dry run \u2014 PrintNode submission disabled" };
  }
  if (!liveOrderStatusMatches(input.observedStatus, input.expected)) {
    return {
      allowed: false,
      reason: "Live order identity/status changed or could not be verified; PrintNode submission refused"
    };
  }
  return { allowed: true, reason: null };
}

// src/lib/printQueue/autoPrint/candidatePlanning.ts
function planAutoPrintDetails(orders, identityOf, printedIds, printedVisuals, maxOrders) {
  const unprinted = [];
  let alreadyPrinted = 0;
  for (const order of orders) {
    const identity = identityOf(order);
    if (printedIds.has(identity.orderId) || printedVisuals.has(String(identity.visualId))) {
      alreadyPrinted += 1;
      continue;
    }
    unprinted.push(order);
  }
  const selected = unprinted.slice(0, Math.max(0, maxOrders));
  return {
    selected,
    alreadyPrinted,
    deferred: Math.max(0, unprinted.length - selected.length)
  };
}

// tests/autoPrintLiveDiscovery.test.ts
var SOURCE_STATUS = "545161";
var OTHER_STATUS = "123";
function node(id, visualId, statusId = SOURCE_STATUS) {
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
      updatedAt: "2026-09-15T00:00:00Z"
    }
  };
}
var FakeClient = class {
  queries = [];
  pages;
  failure;
  constructor(pages, failure) {
    this.pages = pages;
    this.failure = failure;
  }
  async query(query) {
    this.queries.push(query);
    if (this.failure) throw this.failure;
    const kind = query.includes("invoices(") ? "invoices" : "quotes";
    const after = query.match(/after: "([^"]+)"/)?.[1] ?? "first";
    const page = this.pages[`${kind}:${after}`] ?? {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null }
    };
    return { [kind]: page };
  }
};
test("status-scoped live discovery finds an old invoice and never uses local status", async () => {
  const oldInvoice = {
    ...node("old-live-invoice", 18371),
    visualId: "18371"
  };
  const client2 = new FakeClient({
    "invoices:first": {
      nodes: [oldInvoice],
      pageInfo: { hasNextPage: false, endCursor: null }
    }
  });
  const result = await discoverLiveAutoPrintOrders([SOURCE_STATUS], client2);
  assert.deepEqual(
    result.orders.map((order) => order.node.id),
    ["old-live-invoice"]
  );
  assert.equal(result.orders[0]?.node.visualId, 18371);
  assert.ok(client2.queries[0]?.includes('statusIds: ["545161"]'));
  assert.ok(!client2.queries[0]?.includes("inProductionAfter"));
  assert.ok(!client2.queries[0]?.includes("inProductionBefore"));
  assert.ok(!client2.queries[0]?.includes("updatedAfter"));
});
test("a moved-out local candidate is absent from the live set", async () => {
  const client2 = new FakeClient({
    "invoices:first": {
      // The old local row is deliberately not returned by the live
      // status-scoped connection after it moved out of the source status.
      nodes: [node("still-live", 10)],
      pageInfo: { hasNextPage: false, endCursor: null }
    }
  });
  const result = await discoverLiveAutoPrintOrders([SOURCE_STATUS], client2);
  assert.deepEqual(
    result.orders.map((order) => order.node.id),
    ["still-live"]
  );
  assert.ok(
    !result.orders.some((order) => order.node.status?.id === OTHER_STATUS)
  );
});
test("pagination is complete and duplicate visual ids remain one deduped candidate", async () => {
  const client2 = new FakeClient({
    "invoices:first": {
      nodes: [node("invoice-18371", 18371)],
      pageInfo: { hasNextPage: true, endCursor: "invoice-next" }
    },
    "invoices:invoice-next": {
      nodes: [node("invoice-2", 2)],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    "quotes:first": {
      nodes: [node("quote-18371", 18371)],
      pageInfo: { hasNextPage: false, endCursor: null }
    }
  });
  const result = await discoverLiveAutoPrintOrders([SOURCE_STATUS], client2);
  assert.equal(result.pages.invoices, 2);
  assert.equal(result.pages.quotes, 1);
  assert.deepEqual(
    result.orders.map((order) => order.node.id),
    ["invoice-2", "invoice-18371"]
  );
  assert.ok(client2.queries[0]?.includes("sortDescending: false"));
});
test("incomplete pagination fails closed before any print-capable phase", async () => {
  const client2 = new FakeClient({
    "invoices:first": {
      nodes: [node("old-live-invoice", 18371)],
      pageInfo: { hasNextPage: true, endCursor: null }
    }
  });
  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client2),
    (err) => err instanceof LiveDiscoveryError && err.kind === "incomplete_pagination" && err.message.includes("incomplete")
  );
});
test("pagination cursor A-B-A cycle fails closed", async () => {
  const client2 = new FakeClient({
    "invoices:first": {
      nodes: [node("page-a", 1)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-a" }
    },
    "invoices:cursor-a": {
      nodes: [node("page-b", 2)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-b" }
    },
    "invoices:cursor-b": {
      nodes: [node("page-a-again", 3)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-a" }
    }
  });
  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client2),
    (err) => err instanceof LiveDiscoveryError && err.kind === "incomplete_pagination" && err.message.includes("cycle")
  );
});
test("rate/discovery failure fails closed rather than using cached candidates", async () => {
  const client2 = new FakeClient({}, new Error("Printavo rate limit hit twice"));
  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client2),
    (err) => err instanceof LiveDiscoveryError && err.kind === "request" && err.message.includes("rate limit")
  );
});
test("unsupported status filtering reports options before any fallback crawl", async () => {
  const client2 = new FakeClient(
    {},
    new Error("Printavo GraphQL error: Unknown argument statusIds")
  );
  await assert.rejects(
    discoverLiveAutoPrintOrders([SOURCE_STATUS], client2),
    (err) => err instanceof LiveDiscoveryError && err.kind === "unsupported_filter" && err.message.includes("before any fallback crawl")
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
    sourceStatusId: SOURCE_STATUS
  };
  const moved = {
    orderId: expected.orderId,
    visualId: expected.visualId,
    statusId: OTHER_STATUS,
    statusName: "Moved Out"
  };
  assert.equal(liveOrderStatusMatches(moved, expected), false);
  const invalid = checkPrintSafety({
    dryRun: false,
    observedStatus: moved,
    expected
  });
  if (invalid.allowed) printNodeCalls += 1;
  assert.equal(invalid.allowed, false);
  assert.equal(printNodeCalls, 0);
  const failed = checkPrintSafety({
    dryRun: false,
    observedStatus: null,
    expected
  });
  if (failed.allowed) printNodeCalls += 1;
  assert.equal(failed.allowed, false);
  assert.equal(printNodeCalls, 0);
});
test("exact status fence normalizes Printavo numeric-string visual ids", async () => {
  const client2 = {
    async query() {
      return {
        invoice: {
          id: "18816529",
          visualId: "18371",
          status: { id: SOURCE_STATUS, name: "Print Error - Review" }
        }
      };
    }
  };
  const observed = await fetchLiveOrderStatus("invoice", "18816529", client2);
  assert.deepEqual(observed, {
    orderId: "18816529",
    visualId: 18371,
    statusId: SOURCE_STATUS,
    statusName: "Print Error - Review"
  });
});
test("dry-run safety gate never permits PrintNode even with matching live status", () => {
  const result = checkPrintSafety({
    dryRun: true,
    observedStatus: {
      orderId: "18816529",
      visualId: 18371,
      statusId: SOURCE_STATUS,
      statusName: "Print Error - Review"
    },
    expected: {
      orderId: "18816529",
      visualId: 18371,
      sourceStatusId: SOURCE_STATUS
    }
  });
  assert.equal(result.allowed, false);
});
test("printed dedup and MAX cap select detail work before detail requests", () => {
  const live = [
    { orderId: "printed-id", visualId: 1 },
    { orderId: "old-2", visualId: 2 },
    { orderId: "old-3", visualId: 3 },
    { orderId: "old-4", visualId: 4 },
    { orderId: "converted-new-id", visualId: 5 }
  ];
  const plan = planAutoPrintDetails(
    live,
    (order) => order,
    /* @__PURE__ */ new Set(["printed-id"]),
    /* @__PURE__ */ new Set(["5"]),
    2
  );
  const detailRequests = plan.selected.map((order) => order.orderId);
  assert.deepEqual(detailRequests, ["old-2", "old-3"]);
  assert.equal(plan.alreadyPrinted, 2);
  assert.equal(plan.deferred, 1);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidGVzdHMvYXV0b1ByaW50TGl2ZURpc2NvdmVyeS50ZXN0LnRzIiwgIi4uLy4uL2xpYi9wcmludGF2by9zcmMvdGhyb3R0bGUudHMiLCAiLi4vLi4vbGliL3ByaW50YXZvL3NyYy9jbGllbnQudHMiLCAiLi4vLi4vbGliL3ByaW50YXZvL3NyYy9xdWVyaWVzLnRzIiwgInNyYy9saWIvcHJpbnRhdm9HYXRld2F5LnRzIiwgInNyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvbGl2ZURpc2NvdmVyeS50cyIsICJzcmMvbGliL3ByaW50UXVldWUvYXV0b1ByaW50L3NjaGVkdWxlclNhZmV0eS50cyIsICJzcmMvbGliL3ByaW50UXVldWUvYXV0b1ByaW50L3ByaW50U2FmZXR5LnRzIiwgInNyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvY2FuZGlkYXRlUGxhbm5pbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHtcbiAgZGlzY292ZXJMaXZlQXV0b1ByaW50T3JkZXJzLFxuICBmZXRjaExpdmVPcmRlclN0YXR1cyxcbiAgTGl2ZURpc2NvdmVyeUVycm9yLFxuICBsaXZlT3JkZXJTdGF0dXNNYXRjaGVzLFxuICB0eXBlIExpdmVPcmRlclF1ZXJ5Q2xpZW50LFxufSBmcm9tIFwiLi4vc3JjL2xpYi9wcmludFF1ZXVlL2F1dG9QcmludC9saXZlRGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBzY2hlZHVsZWRBdXRvUHJpbnRBbGxvd2VkIH0gZnJvbSBcIi4uL3NyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvc2NoZWR1bGVyU2FmZXR5LnRzXCI7XG5pbXBvcnQgeyBjaGVja1ByaW50U2FmZXR5IH0gZnJvbSBcIi4uL3NyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvcHJpbnRTYWZldHkudHNcIjtcbmltcG9ydCB7IHBsYW5BdXRvUHJpbnREZXRhaWxzIH0gZnJvbSBcIi4uL3NyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvY2FuZGlkYXRlUGxhbm5pbmcudHNcIjtcbmltcG9ydCB0eXBlIHsgUHZPcmRlck5vZGUgfSBmcm9tIFwiQHdvcmtzcGFjZS9wcmludGF2b1wiO1xuXG5jb25zdCBTT1VSQ0VfU1RBVFVTID0gXCI1NDUxNjFcIjtcbmNvbnN0IE9USEVSX1NUQVRVUyA9IFwiMTIzXCI7XG5cbmZ1bmN0aW9uIG5vZGUoXG4gIGlkOiBzdHJpbmcsXG4gIHZpc3VhbElkOiBudW1iZXIsXG4gIHN0YXR1c0lkID0gU09VUkNFX1NUQVRVUyxcbik6IFB2T3JkZXJOb2RlIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICB2aXN1YWxJZCxcbiAgICBuaWNrbmFtZTogYG9yZGVyLSR7dmlzdWFsSWR9YCxcbiAgICB0b3RhbDogbnVsbCxcbiAgICBzdWJ0b3RhbDogbnVsbCxcbiAgICBhbW91bnRQYWlkOiBudWxsLFxuICAgIGFtb3VudE91dHN0YW5kaW5nOiBudWxsLFxuICAgIGN1c3RvbWVyRHVlQXQ6IG51bGwsXG4gICAgaW52b2ljZUF0OiBudWxsLFxuICAgIGR1ZUF0OiBudWxsLFxuICAgIHBheW1lbnREdWVBdDogbnVsbCxcbiAgICBwdWJsaWNVcmw6IG51bGwsXG4gICAgd29ya29yZGVyVXJsOiBgaHR0cHM6Ly9zaG9wLnByaW50YXZvLmNvbS93b3JrX29yZGVycy8ke2lkfWAsXG4gICAgY3VzdG9tZXJOb3RlOiBudWxsLFxuICAgIHByb2R1Y3Rpb25Ob3RlOiBudWxsLFxuICAgIHZpc3VhbFBvTnVtYmVyOiBudWxsLFxuICAgIHRhZ3M6IG51bGwsXG4gICAgc3RhdHVzOiB7IGlkOiBzdGF0dXNJZCwgbmFtZTogc3RhdHVzSWQgPT09IFNPVVJDRV9TVEFUVVMgPyBcIlByaW50IEVycm9yIC0gUmV2aWV3XCIgOiBcIk1vdmVkIE91dFwiIH0sXG4gICAgb3duZXI6IG51bGwsXG4gICAgY29udGFjdDogbnVsbCxcbiAgICBzaGlwcGluZ0FkZHJlc3M6IG51bGwsXG4gICAgYmlsbGluZ0FkZHJlc3M6IG51bGwsXG4gICAgZGVsaXZlcnlNZXRob2Q6IG51bGwsXG4gICAgcGF5bWVudFRlcm06IG51bGwsXG4gICAgdGltZXN0YW1wczoge1xuICAgICAgLy8gVGhpcyBpcyBpbnRlbnRpb25hbGx5IG9sZDogbGl2ZSBkaXNjb3ZlcnkgbXVzdCBub3QgYXBwbHkgYW4gYWdlXG4gICAgICAvLyBjdXRvZmYgd2hpbGUgbG9va2luZyBmb3IgYSBuZXdseSBzdGF0dXNlZCBpbnZvaWNlLlxuICAgICAgY3JlYXRlZEF0OiBcIjIwMjUtMDctMjJUMDA6MDA6MDBaXCIsXG4gICAgICB1cGRhdGVkQXQ6IFwiMjAyNi0wOS0xNVQwMDowMDowMFpcIixcbiAgICB9LFxuICB9O1xufVxuXG5jbGFzcyBGYWtlQ2xpZW50IGltcGxlbWVudHMgTGl2ZU9yZGVyUXVlcnlDbGllbnQge1xuICByZWFkb25seSBxdWVyaWVzOiBzdHJpbmdbXSA9IFtdO1xuICBwcml2YXRlIHJlYWRvbmx5IHBhZ2VzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duW10+O1xuICBwcml2YXRlIHJlYWRvbmx5IGZhaWx1cmU/OiBFcnJvcjtcblxuICBjb25zdHJ1Y3RvcihwYWdlczogUmVjb3JkPHN0cmluZywgdW5rbm93bltdPiwgZmFpbHVyZT86IEVycm9yKSB7XG4gICAgdGhpcy5wYWdlcyA9IHBhZ2VzO1xuICAgIHRoaXMuZmFpbHVyZSA9IGZhaWx1cmU7XG4gIH1cblxuICBhc3luYyBxdWVyeTxUPihxdWVyeTogc3RyaW5nKTogUHJvbWlzZTxUPiB7XG4gICAgdGhpcy5xdWVyaWVzLnB1c2gocXVlcnkpO1xuICAgIGlmICh0aGlzLmZhaWx1cmUpIHRocm93IHRoaXMuZmFpbHVyZTtcbiAgICBjb25zdCBraW5kID0gcXVlcnkuaW5jbHVkZXMoXCJpbnZvaWNlcyhcIikgPyBcImludm9pY2VzXCIgOiBcInF1b3Rlc1wiO1xuICAgIGNvbnN0IGFmdGVyID0gcXVlcnkubWF0Y2goL2FmdGVyOiBcIihbXlwiXSspXCIvKT8uWzFdID8/IFwiZmlyc3RcIjtcbiAgICBjb25zdCBwYWdlID0gdGhpcy5wYWdlc1tgJHtraW5kfToke2FmdGVyfWBdID8/IHtcbiAgICAgIG5vZGVzOiBbXSxcbiAgICAgIHBhZ2VJbmZvOiB7IGhhc05leHRQYWdlOiBmYWxzZSwgZW5kQ3Vyc29yOiBudWxsIH0sXG4gICAgfTtcbiAgICByZXR1cm4geyBba2luZF06IHBhZ2UgfSBhcyBUO1xuICB9XG59XG5cbnRlc3QoXCJzdGF0dXMtc2NvcGVkIGxpdmUgZGlzY292ZXJ5IGZpbmRzIGFuIG9sZCBpbnZvaWNlIGFuZCBuZXZlciB1c2VzIGxvY2FsIHN0YXR1c1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG9sZEludm9pY2UgPSB7XG4gICAgLi4ubm9kZShcIm9sZC1saXZlLWludm9pY2VcIiwgMTgzNzEpLFxuICAgIHZpc3VhbElkOiBcIjE4MzcxXCIsXG4gIH0gYXMgdW5rbm93biBhcyBQdk9yZGVyTm9kZTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEZha2VDbGllbnQoe1xuICAgIFwiaW52b2ljZXM6Zmlyc3RcIjoge1xuICAgICAgbm9kZXM6IFtvbGRJbnZvaWNlXSxcbiAgICAgIHBhZ2VJbmZvOiB7IGhhc05leHRQYWdlOiBmYWxzZSwgZW5kQ3Vyc29yOiBudWxsIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGlzY292ZXJMaXZlQXV0b1ByaW50T3JkZXJzKFtTT1VSQ0VfU1RBVFVTXSwgY2xpZW50KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIHJlc3VsdC5vcmRlcnMubWFwKChvcmRlcikgPT4gb3JkZXIubm9kZS5pZCksXG4gICAgW1wib2xkLWxpdmUtaW52b2ljZVwiXSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vcmRlcnNbMF0/Lm5vZGUudmlzdWFsSWQsIDE4MzcxKTtcbiAgYXNzZXJ0Lm9rKGNsaWVudC5xdWVyaWVzWzBdPy5pbmNsdWRlcygnc3RhdHVzSWRzOiBbXCI1NDUxNjFcIl0nKSk7XG4gIGFzc2VydC5vayghY2xpZW50LnF1ZXJpZXNbMF0/LmluY2x1ZGVzKFwiaW5Qcm9kdWN0aW9uQWZ0ZXJcIikpO1xuICBhc3NlcnQub2soIWNsaWVudC5xdWVyaWVzWzBdPy5pbmNsdWRlcyhcImluUHJvZHVjdGlvbkJlZm9yZVwiKSk7XG4gIGFzc2VydC5vayghY2xpZW50LnF1ZXJpZXNbMF0/LmluY2x1ZGVzKFwidXBkYXRlZEFmdGVyXCIpKTtcbn0pO1xuXG50ZXN0KFwiYSBtb3ZlZC1vdXQgbG9jYWwgY2FuZGlkYXRlIGlzIGFic2VudCBmcm9tIHRoZSBsaXZlIHNldFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBGYWtlQ2xpZW50KHtcbiAgICBcImludm9pY2VzOmZpcnN0XCI6IHtcbiAgICAgIC8vIFRoZSBvbGQgbG9jYWwgcm93IGlzIGRlbGliZXJhdGVseSBub3QgcmV0dXJuZWQgYnkgdGhlIGxpdmVcbiAgICAgIC8vIHN0YXR1cy1zY29wZWQgY29ubmVjdGlvbiBhZnRlciBpdCBtb3ZlZCBvdXQgb2YgdGhlIHNvdXJjZSBzdGF0dXMuXG4gICAgICBub2RlczogW25vZGUoXCJzdGlsbC1saXZlXCIsIDEwKV0sXG4gICAgICBwYWdlSW5mbzogeyBoYXNOZXh0UGFnZTogZmFsc2UsIGVuZEN1cnNvcjogbnVsbCB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRpc2NvdmVyTGl2ZUF1dG9QcmludE9yZGVycyhbU09VUkNFX1NUQVRVU10sIGNsaWVudCk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICByZXN1bHQub3JkZXJzLm1hcCgob3JkZXIpID0+IG9yZGVyLm5vZGUuaWQpLFxuICAgIFtcInN0aWxsLWxpdmVcIl0sXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICAhcmVzdWx0Lm9yZGVycy5zb21lKChvcmRlcikgPT4gb3JkZXIubm9kZS5zdGF0dXM/LmlkID09PSBPVEhFUl9TVEFUVVMpLFxuICApO1xufSk7XG5cbnRlc3QoXCJwYWdpbmF0aW9uIGlzIGNvbXBsZXRlIGFuZCBkdXBsaWNhdGUgdmlzdWFsIGlkcyByZW1haW4gb25lIGRlZHVwZWQgY2FuZGlkYXRlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEZha2VDbGllbnQoe1xuICAgIFwiaW52b2ljZXM6Zmlyc3RcIjoge1xuICAgICAgbm9kZXM6IFtub2RlKFwiaW52b2ljZS0xODM3MVwiLCAxODM3MSldLFxuICAgICAgcGFnZUluZm86IHsgaGFzTmV4dFBhZ2U6IHRydWUsIGVuZEN1cnNvcjogXCJpbnZvaWNlLW5leHRcIiB9LFxuICAgIH0sXG4gICAgXCJpbnZvaWNlczppbnZvaWNlLW5leHRcIjoge1xuICAgICAgbm9kZXM6IFtub2RlKFwiaW52b2ljZS0yXCIsIDIpXSxcbiAgICAgIHBhZ2VJbmZvOiB7IGhhc05leHRQYWdlOiBmYWxzZSwgZW5kQ3Vyc29yOiBudWxsIH0sXG4gICAgfSxcbiAgICBcInF1b3RlczpmaXJzdFwiOiB7XG4gICAgICBub2RlczogW25vZGUoXCJxdW90ZS0xODM3MVwiLCAxODM3MSldLFxuICAgICAgcGFnZUluZm86IHsgaGFzTmV4dFBhZ2U6IGZhbHNlLCBlbmRDdXJzb3I6IG51bGwgfSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNjb3ZlckxpdmVBdXRvUHJpbnRPcmRlcnMoW1NPVVJDRV9TVEFUVVNdLCBjbGllbnQpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQucGFnZXMuaW52b2ljZXMsIDIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnBhZ2VzLnF1b3RlcywgMSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgcmVzdWx0Lm9yZGVycy5tYXAoKG9yZGVyKSA9PiBvcmRlci5ub2RlLmlkKSxcbiAgICBbXCJpbnZvaWNlLTJcIiwgXCJpbnZvaWNlLTE4MzcxXCJdLFxuICApO1xuICBhc3NlcnQub2soY2xpZW50LnF1ZXJpZXNbMF0/LmluY2x1ZGVzKFwic29ydERlc2NlbmRpbmc6IGZhbHNlXCIpKTtcbn0pO1xuXG50ZXN0KFwiaW5jb21wbGV0ZSBwYWdpbmF0aW9uIGZhaWxzIGNsb3NlZCBiZWZvcmUgYW55IHByaW50LWNhcGFibGUgcGhhc2VcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgRmFrZUNsaWVudCh7XG4gICAgXCJpbnZvaWNlczpmaXJzdFwiOiB7XG4gICAgICBub2RlczogW25vZGUoXCJvbGQtbGl2ZS1pbnZvaWNlXCIsIDE4MzcxKV0sXG4gICAgICBwYWdlSW5mbzogeyBoYXNOZXh0UGFnZTogdHJ1ZSwgZW5kQ3Vyc29yOiBudWxsIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgZGlzY292ZXJMaXZlQXV0b1ByaW50T3JkZXJzKFtTT1VSQ0VfU1RBVFVTXSwgY2xpZW50KSxcbiAgICAoZXJyOiB1bmtub3duKSA9PlxuICAgICAgZXJyIGluc3RhbmNlb2YgTGl2ZURpc2NvdmVyeUVycm9yICYmXG4gICAgICBlcnIua2luZCA9PT0gXCJpbmNvbXBsZXRlX3BhZ2luYXRpb25cIiAmJlxuICAgICAgZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJpbmNvbXBsZXRlXCIpLFxuICApO1xufSk7XG5cbnRlc3QoXCJwYWdpbmF0aW9uIGN1cnNvciBBLUItQSBjeWNsZSBmYWlscyBjbG9zZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgRmFrZUNsaWVudCh7XG4gICAgXCJpbnZvaWNlczpmaXJzdFwiOiB7XG4gICAgICBub2RlczogW25vZGUoXCJwYWdlLWFcIiwgMSldLFxuICAgICAgcGFnZUluZm86IHsgaGFzTmV4dFBhZ2U6IHRydWUsIGVuZEN1cnNvcjogXCJjdXJzb3ItYVwiIH0sXG4gICAgfSxcbiAgICBcImludm9pY2VzOmN1cnNvci1hXCI6IHtcbiAgICAgIG5vZGVzOiBbbm9kZShcInBhZ2UtYlwiLCAyKV0sXG4gICAgICBwYWdlSW5mbzogeyBoYXNOZXh0UGFnZTogdHJ1ZSwgZW5kQ3Vyc29yOiBcImN1cnNvci1iXCIgfSxcbiAgICB9LFxuICAgIFwiaW52b2ljZXM6Y3Vyc29yLWJcIjoge1xuICAgICAgbm9kZXM6IFtub2RlKFwicGFnZS1hLWFnYWluXCIsIDMpXSxcbiAgICAgIHBhZ2VJbmZvOiB7IGhhc05leHRQYWdlOiB0cnVlLCBlbmRDdXJzb3I6IFwiY3Vyc29yLWFcIiB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgIGRpc2NvdmVyTGl2ZUF1dG9QcmludE9yZGVycyhbU09VUkNFX1NUQVRVU10sIGNsaWVudCksXG4gICAgKGVycjogdW5rbm93bikgPT5cbiAgICAgIGVyciBpbnN0YW5jZW9mIExpdmVEaXNjb3ZlcnlFcnJvciAmJlxuICAgICAgZXJyLmtpbmQgPT09IFwiaW5jb21wbGV0ZV9wYWdpbmF0aW9uXCIgJiZcbiAgICAgIGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiY3ljbGVcIiksXG4gICk7XG59KTtcblxudGVzdChcInJhdGUvZGlzY292ZXJ5IGZhaWx1cmUgZmFpbHMgY2xvc2VkIHJhdGhlciB0aGFuIHVzaW5nIGNhY2hlZCBjYW5kaWRhdGVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEZha2VDbGllbnQoe30sIG5ldyBFcnJvcihcIlByaW50YXZvIHJhdGUgbGltaXQgaGl0IHR3aWNlXCIpKTtcblxuICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICBkaXNjb3ZlckxpdmVBdXRvUHJpbnRPcmRlcnMoW1NPVVJDRV9TVEFUVVNdLCBjbGllbnQpLFxuICAgIChlcnI6IHVua25vd24pID0+XG4gICAgICBlcnIgaW5zdGFuY2VvZiBMaXZlRGlzY292ZXJ5RXJyb3IgJiZcbiAgICAgIGVyci5raW5kID09PSBcInJlcXVlc3RcIiAmJlxuICAgICAgZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJyYXRlIGxpbWl0XCIpLFxuICApO1xufSk7XG5cbnRlc3QoXCJ1bnN1cHBvcnRlZCBzdGF0dXMgZmlsdGVyaW5nIHJlcG9ydHMgb3B0aW9ucyBiZWZvcmUgYW55IGZhbGxiYWNrIGNyYXdsXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEZha2VDbGllbnQoXG4gICAge30sXG4gICAgbmV3IEVycm9yKFwiUHJpbnRhdm8gR3JhcGhRTCBlcnJvcjogVW5rbm93biBhcmd1bWVudCBzdGF0dXNJZHNcIiksXG4gICk7XG5cbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgZGlzY292ZXJMaXZlQXV0b1ByaW50T3JkZXJzKFtTT1VSQ0VfU1RBVFVTXSwgY2xpZW50KSxcbiAgICAoZXJyOiB1bmtub3duKSA9PlxuICAgICAgZXJyIGluc3RhbmNlb2YgTGl2ZURpc2NvdmVyeUVycm9yICYmXG4gICAgICBlcnIua2luZCA9PT0gXCJ1bnN1cHBvcnRlZF9maWx0ZXJcIiAmJlxuICAgICAgZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJiZWZvcmUgYW55IGZhbGxiYWNrIGNyYXdsXCIpLFxuICApO1xufSk7XG5cbnRlc3QoXCJkZXZlbG9wbWVudCBzY2hlZHVsZXIgYmxvY2tzIGxpdmUgcnVucyBidXQgcGVybWl0cyBkcnkgcnVucyBhbmQgcHJvZHVjdGlvblwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChzY2hlZHVsZWRBdXRvUHJpbnRBbGxvd2VkKGZhbHNlLCBcImRldmVsb3BtZW50XCIpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChzY2hlZHVsZWRBdXRvUHJpbnRBbGxvd2VkKHRydWUsIFwiZGV2ZWxvcG1lbnRcIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2NoZWR1bGVkQXV0b1ByaW50QWxsb3dlZChmYWxzZSwgXCJwcm9kdWN0aW9uXCIpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiUHJpbnROb2RlIHNhZmV0eSBnYXRlIHJlamVjdHMgaW52YWxpZCBsaXZlIHN0YXR1cyBhbmQgZmFpbGVkIGNoZWNrc1wiLCAoKSA9PiB7XG4gIGxldCBwcmludE5vZGVDYWxscyA9IDA7XG4gIGNvbnN0IGV4cGVjdGVkID0ge1xuICAgIG9yZGVySWQ6IFwiMTg4MTY1MjlcIixcbiAgICB2aXN1YWxJZDogMTgzNzEsXG4gICAgc291cmNlU3RhdHVzSWQ6IFNPVVJDRV9TVEFUVVMsXG4gIH07XG4gIGNvbnN0IG1vdmVkID0ge1xuICAgIG9yZGVySWQ6IGV4cGVjdGVkLm9yZGVySWQsXG4gICAgdmlzdWFsSWQ6IGV4cGVjdGVkLnZpc3VhbElkLFxuICAgIHN0YXR1c0lkOiBPVEhFUl9TVEFUVVMsXG4gICAgc3RhdHVzTmFtZTogXCJNb3ZlZCBPdXRcIixcbiAgfTtcbiAgYXNzZXJ0LmVxdWFsKGxpdmVPcmRlclN0YXR1c01hdGNoZXMobW92ZWQsIGV4cGVjdGVkKSwgZmFsc2UpO1xuICBjb25zdCBpbnZhbGlkID0gY2hlY2tQcmludFNhZmV0eSh7XG4gICAgZHJ5UnVuOiBmYWxzZSxcbiAgICBvYnNlcnZlZFN0YXR1czogbW92ZWQsXG4gICAgZXhwZWN0ZWQsXG4gIH0pO1xuICBpZiAoaW52YWxpZC5hbGxvd2VkKSBwcmludE5vZGVDYWxscyArPSAxO1xuICBhc3NlcnQuZXF1YWwoaW52YWxpZC5hbGxvd2VkLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChwcmludE5vZGVDYWxscywgMCk7XG5cbiAgY29uc3QgZmFpbGVkID0gY2hlY2tQcmludFNhZmV0eSh7XG4gICAgZHJ5UnVuOiBmYWxzZSxcbiAgICBvYnNlcnZlZFN0YXR1czogbnVsbCxcbiAgICBleHBlY3RlZCxcbiAgfSk7XG4gIGlmIChmYWlsZWQuYWxsb3dlZCkgcHJpbnROb2RlQ2FsbHMgKz0gMTtcbiAgYXNzZXJ0LmVxdWFsKGZhaWxlZC5hbGxvd2VkLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChwcmludE5vZGVDYWxscywgMCk7XG59KTtcblxudGVzdChcImV4YWN0IHN0YXR1cyBmZW5jZSBub3JtYWxpemVzIFByaW50YXZvIG51bWVyaWMtc3RyaW5nIHZpc3VhbCBpZHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQ6IExpdmVPcmRlclF1ZXJ5Q2xpZW50ID0ge1xuICAgIGFzeW5jIHF1ZXJ5PFQ+KCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgaW52b2ljZToge1xuICAgICAgICAgIGlkOiBcIjE4ODE2NTI5XCIsXG4gICAgICAgICAgdmlzdWFsSWQ6IFwiMTgzNzFcIixcbiAgICAgICAgICBzdGF0dXM6IHsgaWQ6IFNPVVJDRV9TVEFUVVMsIG5hbWU6IFwiUHJpbnQgRXJyb3IgLSBSZXZpZXdcIiB9LFxuICAgICAgICB9LFxuICAgICAgfSBhcyBUO1xuICAgIH0sXG4gIH07XG4gIGNvbnN0IG9ic2VydmVkID0gYXdhaXQgZmV0Y2hMaXZlT3JkZXJTdGF0dXMoXCJpbnZvaWNlXCIsIFwiMTg4MTY1MjlcIiwgY2xpZW50KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChvYnNlcnZlZCwge1xuICAgIG9yZGVySWQ6IFwiMTg4MTY1MjlcIixcbiAgICB2aXN1YWxJZDogMTgzNzEsXG4gICAgc3RhdHVzSWQ6IFNPVVJDRV9TVEFUVVMsXG4gICAgc3RhdHVzTmFtZTogXCJQcmludCBFcnJvciAtIFJldmlld1wiLFxuICB9KTtcbn0pO1xuXG50ZXN0KFwiZHJ5LXJ1biBzYWZldHkgZ2F0ZSBuZXZlciBwZXJtaXRzIFByaW50Tm9kZSBldmVuIHdpdGggbWF0Y2hpbmcgbGl2ZSBzdGF0dXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjaGVja1ByaW50U2FmZXR5KHtcbiAgICBkcnlSdW46IHRydWUsXG4gICAgb2JzZXJ2ZWRTdGF0dXM6IHtcbiAgICAgIG9yZGVySWQ6IFwiMTg4MTY1MjlcIixcbiAgICAgIHZpc3VhbElkOiAxODM3MSxcbiAgICAgIHN0YXR1c0lkOiBTT1VSQ0VfU1RBVFVTLFxuICAgICAgc3RhdHVzTmFtZTogXCJQcmludCBFcnJvciAtIFJldmlld1wiLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIG9yZGVySWQ6IFwiMTg4MTY1MjlcIixcbiAgICAgIHZpc3VhbElkOiAxODM3MSxcbiAgICAgIHNvdXJjZVN0YXR1c0lkOiBTT1VSQ0VfU1RBVFVTLFxuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFsbG93ZWQsIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwicHJpbnRlZCBkZWR1cCBhbmQgTUFYIGNhcCBzZWxlY3QgZGV0YWlsIHdvcmsgYmVmb3JlIGRldGFpbCByZXF1ZXN0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGxpdmUgPSBbXG4gICAgeyBvcmRlcklkOiBcInByaW50ZWQtaWRcIiwgdmlzdWFsSWQ6IDEgfSxcbiAgICB7IG9yZGVySWQ6IFwib2xkLTJcIiwgdmlzdWFsSWQ6IDIgfSxcbiAgICB7IG9yZGVySWQ6IFwib2xkLTNcIiwgdmlzdWFsSWQ6IDMgfSxcbiAgICB7IG9yZGVySWQ6IFwib2xkLTRcIiwgdmlzdWFsSWQ6IDQgfSxcbiAgICB7IG9yZGVySWQ6IFwiY29udmVydGVkLW5ldy1pZFwiLCB2aXN1YWxJZDogNSB9LFxuICBdO1xuICBjb25zdCBwbGFuID0gcGxhbkF1dG9QcmludERldGFpbHMoXG4gICAgbGl2ZSxcbiAgICAob3JkZXIpID0+IG9yZGVyLFxuICAgIG5ldyBTZXQoW1wicHJpbnRlZC1pZFwiXSksXG4gICAgbmV3IFNldChbXCI1XCJdKSxcbiAgICAyLFxuICApO1xuICBjb25zdCBkZXRhaWxSZXF1ZXN0cyA9IHBsYW4uc2VsZWN0ZWQubWFwKChvcmRlcikgPT4gb3JkZXIub3JkZXJJZCk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZGV0YWlsUmVxdWVzdHMsIFtcIm9sZC0yXCIsIFwib2xkLTNcIl0pO1xuICBhc3NlcnQuZXF1YWwocGxhbi5hbHJlYWR5UHJpbnRlZCwgMik7XG4gIGFzc2VydC5lcXVhbChwbGFuLmRlZmVycmVkLCAxKTtcbn0pOyIsICJleHBvcnQgZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcbn1cblxuLyoqXG4gKiBTZXJpYWxpemVzIGFsbCByZXF1ZXN0cyB0aHJvdWdoIGEgc2luZ2xlIHByb21pc2UgY2hhaW4gYW5kIGVuZm9yY2VzIGFcbiAqIG1pbmltdW0gaW50ZXJ2YWwgYmV0d2VlbiB0aGUgRU5EIG9mIG9uZSByZXF1ZXN0IGFuZCB0aGUgU1RBUlQgb2YgdGhlIG5leHQuXG4gKlxuICogSU5WQVJJQU5UOiB0aGlzIGdhdGUgaXMgaW4tcHJvY2VzcyBvbmx5LiBJdCBpcyBzYWZlIG9ubHkgd2hpbGUgZXZlcnlcbiAqIFByaW50YXZvIGNhbGwgaW4gdGhlIGFjY291bnQgZmxvd3MgdGhyb3VnaCBPTkUgYXBpLXNlcnZlciBwcm9jZXNzLlxuICovXG5leHBvcnQgY2xhc3MgUmVxdWVzdEdhdGUge1xuICBwcml2YXRlIHF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIHByaXZhdGUgbGFzdFJlcXVlc3RFbmRlZEF0ID0gMDtcblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IG1pbkludGVydmFsTXM6IG51bWJlcikge31cblxuICBzY2hlZHVsZTxUPihmbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICAgIGNvbnN0IHJ1biA9IHRoaXMucXVldWUudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB3YWl0ID0gdGhpcy5sYXN0UmVxdWVzdEVuZGVkQXQgKyB0aGlzLm1pbkludGVydmFsTXMgLSBEYXRlLm5vdygpO1xuICAgICAgaWYgKHdhaXQgPiAwKSB7XG4gICAgICAgIGF3YWl0IHNsZWVwKHdhaXQpO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGZuKCk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLmxhc3RSZXF1ZXN0RW5kZWRBdCA9IERhdGUubm93KCk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdGhpcy5xdWV1ZSA9IHJ1bi50aGVuKFxuICAgICAgKCkgPT4gdW5kZWZpbmVkLFxuICAgICAgKCkgPT4gdW5kZWZpbmVkLFxuICAgICk7XG4gICAgcmV0dXJuIHJ1bjtcbiAgfVxufVxuIiwgImltcG9ydCB7IFJlcXVlc3RHYXRlLCBzbGVlcCB9IGZyb20gXCIuL3Rocm90dGxlXCI7XG5cbmV4cG9ydCBjb25zdCBQUklOVEFWT19FTkRQT0lOVCA9IFwiaHR0cHM6Ly93d3cucHJpbnRhdm8uY29tL2FwaS92MlwiO1xuXG4vKiogfjggcmVxIC8gNXMuIDU1MG1zIHRyaXBwZWQgcmVhbCA0MjlzIG9uIGJ1cnN0czsgNjIwbXMgaXMgdGhlIHByb3Zlbi1zYWZlIHNwYWNpbmcuICovXG5leHBvcnQgY29uc3QgTUlOX0lOVEVSVkFMX01TID0gNjIwO1xuXG4vKiogQ29vbGRvd24gYmVmb3JlIHRoZSBzaW5nbGUgcmV0cnkgYWZ0ZXIgYSA0MjkuICovXG5leHBvcnQgY29uc3QgUkVUUllfQUZURVJfNDI5X01TID0gNTIwMDtcblxuLyoqXG4gKiBQcmludGF2byBzcG9yYWRpY2FsbHkgcmV0dXJucyB0cmFuc2llbnQgc2VydmVyLXNpZGUgdGltZW91dHMgYXMgR3JhcGhRTFxuICogZXJyb3JzIGluIGFuIEhUVFAgMjAwIChvYnNlcnZlZDogXCJUaW1lb3V0IG9uIElEZWQuaWRcIikuIFF1ZXJpZXMgYXJlXG4gKiByZWFkLW9ubHksIHNvIHJlLXNlbmRpbmcgaXMgc2FmZSBcdTIwMTQgcmV0cnkgd2l0aCBiYWNrb2ZmIGluc3RlYWQgb2ZcbiAqIGZhaWxpbmcgYSB3aG9sZSBzeW5jIHJ1bi5cbiAqL1xuZXhwb3J0IGNvbnN0IEdSQVBIUUxfVElNRU9VVF9SRVRSWV9ERUxBWVNfTVMgPSBbNV8wMDAsIDE1XzAwMCwgMzBfMDAwXTtcblxuZnVuY3Rpb24gaXNUcmFuc2llbnRUaW1lb3V0KGVycm9yczogQXJyYXk8eyBtZXNzYWdlPzogc3RyaW5nIH0+KTogYm9vbGVhbiB7XG4gIHJldHVybiBlcnJvcnMuZXZlcnkoXG4gICAgKGUpID0+IHR5cGVvZiBlLm1lc3NhZ2UgPT09IFwic3RyaW5nXCIgJiYgZS5tZXNzYWdlLnN0YXJ0c1dpdGgoXCJUaW1lb3V0IG9uXCIpLFxuICApO1xufVxuXG4vKiogQmFja29mZiBzY2hlZHVsZSBmb3IgdHJhbnNpZW50IG5ldHdvcmsgZXJyb3JzIChFQ09OTlJFU0VUIGV0YykuICovXG5leHBvcnQgY29uc3QgTkVUV09SS19SRVRSWV9ERUxBWVNfTVMgPSBbMjAwMCwgNjAwMF07XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJpbnRhdm9DbGllbnRPcHRpb25zIHtcbiAgZW1haWw6IHN0cmluZztcbiAgdG9rZW46IHN0cmluZztcbiAgZW5kcG9pbnQ/OiBzdHJpbmc7XG4gIG1pbkludGVydmFsTXM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJpbnRhdm9DbGllbnRTdGF0cyB7XG4gIHJlcXVlc3RDb3VudDogbnVtYmVyO1xuICByZXRyeUNvdW50OiBudW1iZXI7XG4gIGVycm9yQ291bnQ6IG51bWJlcjtcbiAgbGFzdFJlcXVlc3RBdDogc3RyaW5nIHwgbnVsbDtcbiAgbGFzdDQyOUF0OiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgY2xhc3MgUHJpbnRhdm9BcGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHB1YmxpYyByZWFkb25seSBodHRwU3RhdHVzPzogbnVtYmVyLFxuICAgIHB1YmxpYyByZWFkb25seSBncmFwaHFsRXJyb3JzPzogdW5rbm93bltdLFxuICAgIC8qKlxuICAgICAqIFBhcnRpYWwgYGRhdGFgIHJldHVybmVkIGFsb25nc2lkZSBHcmFwaFFMIGVycm9ycyAoSFRUUCAyMDApLlxuICAgICAqIFByaW50YXZvJ3Mgc2NoZW1hIGRlY2xhcmVzIHNvbWUgZmllbGRzIG5vbi1udWxsYWJsZSB0aGF0IENBTiBiZVxuICAgICAqIG51bGwgaW4gcHJhY3RpY2UgKGUuZy4gUHVyY2hhc2VPcmRlci52ZW5kb3IgYWZ0ZXIgYSB2ZW5kb3IgaXNcbiAgICAgKiBkZWxldGVkKTsgY2FsbGVycyB0aGF0IGNhbiB0b2xlcmF0ZSB0aGUgZ2FwIG1heSBzYWx2YWdlIHRoaXMuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHBhcnRpYWxEYXRhPzogdW5rbm93bixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJQcmludGF2b0FwaUVycm9yXCI7XG4gIH1cbn1cblxuaW50ZXJmYWNlIEdyYXBoUUxSZXNwb25zZTxUPiB7XG4gIGRhdGE/OiBUO1xuICBlcnJvcnM/OiBBcnJheTx7IG1lc3NhZ2U/OiBzdHJpbmcgfT47XG59XG5cbmludGVyZmFjZSBCdWZmZXJlZFJlc3BvbnNlIHtcbiAgc3RhdHVzOiBudW1iZXI7XG4gIG9rOiBib29sZWFuO1xuICBib2R5VGV4dDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgUHJpbnRhdm9DbGllbnQge1xuICBwcml2YXRlIHJlYWRvbmx5IGdhdGU6IFJlcXVlc3RHYXRlO1xuICBwcml2YXRlIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgZW1haWw6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nO1xuXG4gIHByaXZhdGUgcmVxdWVzdENvdW50ID0gMDtcbiAgcHJpdmF0ZSByZXRyeUNvdW50ID0gMDtcbiAgcHJpdmF0ZSBlcnJvckNvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0UmVxdWVzdEF0OiBEYXRlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbGFzdDQyOUF0OiBEYXRlIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9uczogUHJpbnRhdm9DbGllbnRPcHRpb25zKSB7XG4gICAgdGhpcy5lbWFpbCA9IG9wdGlvbnMuZW1haWw7XG4gICAgdGhpcy50b2tlbiA9IG9wdGlvbnMudG9rZW47XG4gICAgdGhpcy5lbmRwb2ludCA9IG9wdGlvbnMuZW5kcG9pbnQgPz8gUFJJTlRBVk9fRU5EUE9JTlQ7XG4gICAgdGhpcy5nYXRlID0gbmV3IFJlcXVlc3RHYXRlKG9wdGlvbnMubWluSW50ZXJ2YWxNcyA/PyBNSU5fSU5URVJWQUxfTVMpO1xuICB9XG5cbiAgZ2V0IHN0YXRzKCk6IFByaW50YXZvQ2xpZW50U3RhdHMge1xuICAgIHJldHVybiB7XG4gICAgICByZXF1ZXN0Q291bnQ6IHRoaXMucmVxdWVzdENvdW50LFxuICAgICAgcmV0cnlDb3VudDogdGhpcy5yZXRyeUNvdW50LFxuICAgICAgZXJyb3JDb3VudDogdGhpcy5lcnJvckNvdW50LFxuICAgICAgbGFzdFJlcXVlc3RBdDogdGhpcy5sYXN0UmVxdWVzdEF0Py50b0lTT1N0cmluZygpID8/IG51bGwsXG4gICAgICBsYXN0NDI5QXQ6IHRoaXMubGFzdDQyOUF0Py50b0lTT1N0cmluZygpID8/IG51bGwsXG4gICAgfTtcbiAgfVxuXG4gIC8qKiBBbGwgUHJpbnRhdm8gdHJhZmZpYyBtdXN0IGdvIHRocm91Z2ggdGhpcyBtZXRob2QuICovXG4gIHF1ZXJ5PFQ+KHF1ZXJ5OiBzdHJpbmcsIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSk6IFByb21pc2U8VD4ge1xuICAgIHJldHVybiB0aGlzLmdhdGUuc2NoZWR1bGUoKCkgPT4gdGhpcy5leGVjdXRlPFQ+KHF1ZXJ5LCB2YXJpYWJsZXMsIHRydWUpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFeGVjdXRlIGEgbm9uLWlkZW1wb3RlbnQgR3JhcGhRTCBtdXRhdGlvbiBleGFjdGx5IG9uY2UuXG4gICAqXG4gICAqIEEgY29ubmVjdGlvbiBkcm9wIGFmdGVyIFByaW50YXZvIGFjY2VwdHMgYSBtdXRhdGlvbiBjYW4gbG9vayBpZGVudGljYWwgdG9cbiAgICogYSBkcm9wIGJlZm9yZSBpdCBhY2NlcHRzIGl0LiBSZXRyeWluZyBpbiBlaXRoZXIgdGhpcyBjbGllbnQgb3IgYSBjYWxsZXJcbiAgICogY291bGQgY3JlYXRlIGEgZHVwbGljYXRlIHF1b3RlL29yZGVyLCBzbyB3cml0ZXMgaW50ZW50aW9uYWxseSBnZXQgbm8gNDI5LFxuICAgKiB0aW1lb3V0LCBvciBuZXR3b3JrIHJldHJ5LiBDYWxsZXJzIG11c3QgcGVyc2lzdCBhbWJpZ3VvdXMgb3V0Y29tZXMgZm9yXG4gICAqIG9wZXJhdG9yIHJldmlldy5cbiAgICovXG4gIG11dGF0ZTxUPihtdXRhdGlvbjogc3RyaW5nLCB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pOiBQcm9taXNlPFQ+IHtcbiAgICByZXR1cm4gdGhpcy5nYXRlLnNjaGVkdWxlKCgpID0+IHRoaXMuZXhlY3V0ZTxUPihtdXRhdGlvbiwgdmFyaWFibGVzLCBmYWxzZSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlPFQ+KFxuICAgIHF1ZXJ5OiBzdHJpbmcsXG4gICAgdmFyaWFibGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBhbGxvd1JldHJ5OiBib29sZWFuLFxuICApOiBQcm9taXNlPFQ+IHtcbiAgICBmb3IgKGxldCB0aW1lb3V0QXR0ZW1wdCA9IDA7IDsgdGltZW91dEF0dGVtcHQrKykge1xuICAgICAgbGV0IHJlc3BvbnNlID0gYWxsb3dSZXRyeVxuICAgICAgICA/IGF3YWl0IHRoaXMucG9zdFdpdGhOZXR3b3JrUmV0cnkocXVlcnksIHZhcmlhYmxlcylcbiAgICAgICAgOiBhd2FpdCB0aGlzLnBvc3RPbmNlKHF1ZXJ5LCB2YXJpYWJsZXMpO1xuXG4gICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MjkpIHtcbiAgICAgICAgaWYgKCFhbGxvd1JldHJ5KSB7XG4gICAgICAgICAgdGhpcy5sYXN0NDI5QXQgPSBuZXcgRGF0ZSgpO1xuICAgICAgICAgIHRoaXMuZXJyb3JDb3VudCArPSAxO1xuICAgICAgICAgIHRocm93IG5ldyBQcmludGF2b0FwaUVycm9yKFxuICAgICAgICAgICAgXCJQcmludGF2byByYXRlIGxpbWl0ZWQgYSBub24taWRlbXBvdGVudCBtdXRhdGlvbjsgaXQgd2FzIG5vdCByZXRyaWVkXCIsXG4gICAgICAgICAgICA0MjksXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmxhc3Q0MjlBdCA9IG5ldyBEYXRlKCk7XG4gICAgICAgIHRoaXMucmV0cnlDb3VudCArPSAxO1xuICAgICAgICBhd2FpdCBzbGVlcChSRVRSWV9BRlRFUl80MjlfTVMpO1xuICAgICAgICByZXNwb25zZSA9IGF3YWl0IHRoaXMucG9zdFdpdGhOZXR3b3JrUmV0cnkocXVlcnksIHZhcmlhYmxlcyk7XG4gICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xuICAgICAgICAgIHRoaXMuZXJyb3JDb3VudCArPSAxO1xuICAgICAgICAgIHRocm93IG5ldyBQcmludGF2b0FwaUVycm9yKFxuICAgICAgICAgICAgXCJQcmludGF2byByYXRlIGxpbWl0IGhpdCB0d2ljZSBpbiBhIHJvdyAoNDI5IGFmdGVyIGNvb2xkb3duIHJldHJ5KVwiLFxuICAgICAgICAgICAgNDI5LFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICB0aGlzLmVycm9yQ291bnQgKz0gMTtcbiAgICAgICAgdGhyb3cgbmV3IFByaW50YXZvQXBpRXJyb3IoXG4gICAgICAgICAgYFByaW50YXZvIEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9OiAke3Jlc3BvbnNlLmJvZHlUZXh0LnNsaWNlKDAsIDUwMCl9YCxcbiAgICAgICAgICByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGxldCBib2R5OiBHcmFwaFFMUmVzcG9uc2U8VD47XG4gICAgICB0cnkge1xuICAgICAgICBib2R5ID0gSlNPTi5wYXJzZShyZXNwb25zZS5ib2R5VGV4dCkgYXMgR3JhcGhRTFJlc3BvbnNlPFQ+O1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHRoaXMuZXJyb3JDb3VudCArPSAxO1xuICAgICAgICB0aHJvdyBuZXcgUHJpbnRhdm9BcGlFcnJvcihcbiAgICAgICAgICBgUHJpbnRhdm8gcmV0dXJuZWQgaW52YWxpZCBKU09OOiAke3Jlc3BvbnNlLmJvZHlUZXh0LnNsaWNlKDAsIDIwMCl9YCxcbiAgICAgICAgICByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGlmIChib2R5LmVycm9ycyAmJiBib2R5LmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBhbGxvd1JldHJ5ICYmXG4gICAgICAgICAgaXNUcmFuc2llbnRUaW1lb3V0KGJvZHkuZXJyb3JzKSAmJlxuICAgICAgICAgIHRpbWVvdXRBdHRlbXB0IDwgR1JBUEhRTF9USU1FT1VUX1JFVFJZX0RFTEFZU19NUy5sZW5ndGhcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhpcy5yZXRyeUNvdW50ICs9IDE7XG4gICAgICAgICAgYXdhaXQgc2xlZXAoR1JBUEhRTF9USU1FT1VUX1JFVFJZX0RFTEFZU19NU1t0aW1lb3V0QXR0ZW1wdF0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZXJyb3JDb3VudCArPSAxO1xuICAgICAgICBjb25zdCBtZXNzYWdlcyA9IGJvZHkuZXJyb3JzXG4gICAgICAgICAgLm1hcCgoZSkgPT4gZS5tZXNzYWdlID8/IEpTT04uc3RyaW5naWZ5KGUpKVxuICAgICAgICAgIC5qb2luKFwiOyBcIik7XG4gICAgICAgIHRocm93IG5ldyBQcmludGF2b0FwaUVycm9yKFxuICAgICAgICAgIGBQcmludGF2byBHcmFwaFFMIGVycm9yOiAke21lc3NhZ2VzfWAsXG4gICAgICAgICAgcmVzcG9uc2Uuc3RhdHVzLFxuICAgICAgICAgIGJvZHkuZXJyb3JzLFxuICAgICAgICAgIGJvZHkuZGF0YSA/PyB1bmRlZmluZWQsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGlmIChib2R5LmRhdGEgPT09IHVuZGVmaW5lZCB8fCBib2R5LmRhdGEgPT09IG51bGwpIHtcbiAgICAgICAgdGhpcy5lcnJvckNvdW50ICs9IDE7XG4gICAgICAgIHRocm93IG5ldyBQcmludGF2b0FwaUVycm9yKFxuICAgICAgICAgIFwiUHJpbnRhdm8gcmV0dXJuZWQgbm8gZGF0YVwiLFxuICAgICAgICAgIHJlc3BvbnNlLnN0YXR1cyxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGJvZHkuZGF0YTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogZmV0Y2goKSAoYW5kIGJvZHkgc3RyZWFtaW5nKSByZWplY3Qgd2l0aCBUeXBlRXJyb3IgKFwiZmV0Y2ggZmFpbGVkXCIgL1xuICAgKiBcInRlcm1pbmF0ZWRcIikgb24gY29ubmVjdGlvbi1sZXZlbCBmYWlsdXJlcyAoRUNPTk5SRVNFVCwgRE5TIGJsaXBzKS5cbiAgICogVGhlc2UgYXJlIHRyYW5zaWVudCBcdTIwMTQgcmV0cnkgd2l0aCBiYWNrb2ZmIGluc3RlYWQgb2YgZmFpbGluZyB0aGUgd2hvbGVcbiAgICogc3luYyBydW4uIFRoZSByZXNwb25zZSBib2R5IGlzIGZ1bGx5IGJ1ZmZlcmVkIElOU0lERSB0aGUgcmV0cmllZCB1bml0XG4gICAqIGJlY2F1c2UgY29ubmVjdGlvbiBkcm9wcyBzdXJmYWNlIGR1cmluZyBib2R5IHJlYWRzIHRvbywgbm90IGp1c3Qgb25cbiAgICogdGhlIGluaXRpYWwgZmV0Y2guIEdyYXBoUUwgcXVlcmllcyBhcmUgcmVhZC1vbmx5LCBzbyByZS1zZW5kaW5nIGFmdGVyXG4gICAqIGEgcGFydGlhbCBleGNoYW5nZSBpcyBzYWZlLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBwb3N0V2l0aE5ldHdvcmtSZXRyeShcbiAgICBxdWVyeTogc3RyaW5nLFxuICAgIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICk6IFByb21pc2U8QnVmZmVyZWRSZXNwb25zZT4ge1xuICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnBvc3QocXVlcnksIHZhcmlhYmxlcyk7XG4gICAgICAgIGNvbnN0IGJvZHlUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgICByZXR1cm4geyBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgb2s6IHJlc3BvbnNlLm9rLCBib2R5VGV4dCB9O1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChhdHRlbXB0ID49IE5FVFdPUktfUkVUUllfREVMQVlTX01TLmxlbmd0aCkge1xuICAgICAgICAgIHRoaXMuZXJyb3JDb3VudCArPSAxO1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnJldHJ5Q291bnQgKz0gMTtcbiAgICAgICAgYXdhaXQgc2xlZXAoTkVUV09SS19SRVRSWV9ERUxBWVNfTVNbYXR0ZW1wdF0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcG9zdE9uY2UoXG4gICAgcXVlcnk6IHN0cmluZyxcbiAgICB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICApOiBQcm9taXNlPEJ1ZmZlcmVkUmVzcG9uc2U+IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMucG9zdChxdWVyeSwgdmFyaWFibGVzKTtcbiAgICBjb25zdCBib2R5VGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICByZXR1cm4geyBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgb2s6IHJlc3BvbnNlLm9rLCBib2R5VGV4dCB9O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwb3N0KFxuICAgIHF1ZXJ5OiBzdHJpbmcsXG4gICAgdmFyaWFibGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICAgIHRoaXMucmVxdWVzdENvdW50ICs9IDE7XG4gICAgdGhpcy5sYXN0UmVxdWVzdEF0ID0gbmV3IERhdGUoKTtcbiAgICByZXR1cm4gZmV0Y2godGhpcy5lbmRwb2ludCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIGVtYWlsOiB0aGlzLmVtYWlsLFxuICAgICAgICB0b2tlbjogdGhpcy50b2tlbixcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHF1ZXJ5LCB2YXJpYWJsZXMgfSksXG4gICAgfSk7XG4gIH1cbn1cbiIsICIvKipcbiAqIEdyYXBoUUwgcXVlcnkgYnVpbGRlcnMgZm9yIFByaW50YXZvIHYyLlxuICpcbiAqIFZhbHVlcyBhcmUgaW5saW5lZCBhcyBsaXRlcmFscyAoc2FmZWx5IEpTT04tcXVvdGVkKSBpbnN0ZWFkIG9mIHR5cGVkXG4gKiB2YXJpYWJsZXMgc28gd2UgbmV2ZXIgaGF2ZSB0byBndWVzcyBQcmludGF2bydzIHNjYWxhci9lbnVtIHR5cGUgbmFtZXMuXG4gKlxuICogQ29uc3RyYWludHMgKHZlcmlmaWVkIHZpYSBsaXZlIHNjaGVtYSBpbnRyb3NwZWN0aW9uLCBKdWx5IDIwMjYpOlxuICogLSBwYWdlIHNpemUgaGFyZC1jYXBwZWQgYXQgMjUgcmVnYXJkbGVzcyBvZiBgZmlyc3RgXG4gKiAtIE5PIGB1cGRhdGVkQWZ0ZXJgIC8gY2hhbmdlZC1zaW5jZSBmaWx0ZXIgZXhpc3RzIG9uIGFueSBsaXN0IGZpZWxkXG4gKiAtIG5vIFVQREFURURfQVQgc29ydDsgVklTVUFMX0lEIGRlc2MgaXMgdGhlIHJlY2VuY3kgcHJveHksIHNvXG4gKiAgIGluY3JlbWVudGFsIHN5bmMgPSBmdWxsIHJlLWNyYXdsIHRvIGN1dG9mZiArIGhhc2ggZGlmZlxuICovXG5cbmV4cG9ydCBjb25zdCBQQUdFX1NJWkUgPSAyNTtcblxuZnVuY3Rpb24gbGl0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xufVxuXG5mdW5jdGlvbiBhZnRlckFyZyhhZnRlcjogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIHJldHVybiBhZnRlciA/IGAsIGFmdGVyOiAke2xpdChhZnRlcil9YCA6IFwiXCI7XG59XG5cbmNvbnN0IEFERFJFU1NfRklFTERTID0gYFxuICBjdXN0b21lck5hbWVcbiAgY29tcGFueU5hbWVcbiAgYWRkcmVzczFcbiAgYWRkcmVzczJcbiAgY2l0eVxuICBzdGF0ZVxuICBzdGF0ZUlzb1xuICB6aXBDb2RlXG4gIGNvdW50cnlcbmA7XG5cbmNvbnN0IE9SREVSX05PREVfRklFTERTID0gYFxuICBpZFxuICB2aXN1YWxJZFxuICBuaWNrbmFtZVxuICB0b3RhbFxuICBzdWJ0b3RhbFxuICBhbW91bnRQYWlkXG4gIGFtb3VudE91dHN0YW5kaW5nXG4gIGN1c3RvbWVyRHVlQXRcbiAgaW52b2ljZUF0XG4gIGR1ZUF0XG4gIHBheW1lbnREdWVBdFxuICBwdWJsaWNVcmxcbiAgd29ya29yZGVyVXJsXG4gIGN1c3RvbWVyTm90ZVxuICBwcm9kdWN0aW9uTm90ZVxuICB2aXN1YWxQb051bWJlclxuICB0YWdzXG4gIGNyZWF0ZWRBdFxuICBzdGFydEF0XG4gIGRpc2NvdW50XG4gIGRpc2NvdW50QW1vdW50XG4gIGRpc2NvdW50QXNQZXJjZW50YWdlXG4gIHNhbGVzVGF4XG4gIHNhbGVzVGF4QW1vdW50XG4gIHRvdGFsVW50YXhlZFxuICB0b3RhbFF1YW50aXR5XG4gIHBhaWRJbkZ1bGxcbiAgbWVyY2hcbiAgcGFja2luZ1NsaXBVcmxcbiAgcHVibGljUGRmXG4gIHB1YmxpY0hhc2hcbiAgdXJsXG4gIHN0YXR1cyB7IGlkIG5hbWUgfVxuICBvd25lciB7IGlkIGVtYWlsIH1cbiAgY29udGFjdCB7IGlkIGZ1bGxOYW1lIGVtYWlsIGN1c3RvbWVyIHsgaWQgY29tcGFueU5hbWUgfSB9XG4gIHNoaXBwaW5nQWRkcmVzcyB7ICR7QUREUkVTU19GSUVMRFN9IH1cbiAgYmlsbGluZ0FkZHJlc3MgeyAke0FERFJFU1NfRklFTERTfSB9XG4gIGRlbGl2ZXJ5TWV0aG9kIHsgaWQgbmFtZSBhcmNoaXZlZCB9XG4gIHBheW1lbnRUZXJtIHsgaWQgbmFtZSBkYXlzIGFyY2hpdmVkIH1cbiAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuYDtcblxuY29uc3QgUEFHRV9JTkZPID0gYHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgZW5kQ3Vyc29yIH1gO1xuXG5leHBvcnQgaW50ZXJmYWNlIE9yZGVyUGFnZUFyZ3Mge1xuICBhZnRlcj86IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBSZXN0cmljdCB0aGUgbGlzdCBhdCBQcmludGF2byBiZWZvcmUgcGFnaW5hdGlvbi4gVGhlIHYyIHNjaGVtYSBhY2NlcHRzXG4gICAqIGBzdGF0dXNJZHM6IFtJRCFdYCBvbiBib3RoIGludm9pY2VzIGFuZCBxdW90ZXMgKHZlcmlmaWVkIGJ5IGxpdmVcbiAgICogaW50cm9zcGVjdGlvbikuIEF1dG8tcHJpbnQgdXNlcyB0aGlzIGluc3RlYWQgb2YgY3Jhd2xpbmcgdGhlIGNvbXBsZXRlXG4gICAqIG9yZGVyIGhpc3RvcnkgYW5kIGZpbHRlcmluZyBhIHN0YWxlIGxvY2FsIG1pcnJvci5cbiAgICovXG4gIHN0YXR1c0lkcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKipcbiAgICogVklTVUFMX0lEIHNvcnQgZGlyZWN0aW9uLiBEZWZhdWx0IHRydWUgKG5ld2VzdC1maXJzdCkgXHUyMDE0IHRoZVxuICAgKiBpbmNyZW1lbnRhbCBjcmF3bCdzIHJlY2VuY3kgcHJveHkuIEhpc3RvcnkgYmFja2ZpbGwgcGFzc2VzIGZhbHNlXG4gICAqIHRvIHdhbGsgdGhlIGFyY2hpdmUgb2xkZXN0LWZpcnN0ICh2ZXJpZmllZCBsaXZlOiBhc2NlbmRpbmcgc29ydFxuICAgKiB3b3Jrczsgbm90ZSB2aXN1YWwgaWRzIGFyZSBOT1QgZGF0ZS1vcmRlcmVkLCBlLmcuIGludm9pY2UgIzEwMDBcbiAgICogd2FzIGNyZWF0ZWQgaW4gMjAyMSkuXG4gICAqL1xuICBzb3J0RGVzY2VuZGluZz86IGJvb2xlYW47XG59XG5cbmZ1bmN0aW9uIHNvcnREZXNjQXJnKHNvcnREZXNjZW5kaW5nOiBib29sZWFuIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNvcnREZXNjZW5kaW5nID09PSBmYWxzZSA/IFwiZmFsc2VcIiA6IFwidHJ1ZVwiO1xufVxuXG5mdW5jdGlvbiBzdGF0dXNJZHNBcmcoc3RhdHVzSWRzOiByZWFkb25seSBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGlmICghc3RhdHVzSWRzIHx8IHN0YXR1c0lkcy5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuICByZXR1cm4gYCwgc3RhdHVzSWRzOiBbJHtzdGF0dXNJZHMubWFwKGxpdCkuam9pbihcIiwgXCIpfV1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW52b2ljZXNQYWdlUXVlcnkoYXJnczogT3JkZXJQYWdlQXJncyA9IHt9KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgaW52b2ljZXMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYXJncy5hZnRlcil9JHtzdGF0dXNJZHNBcmcoYXJncy5zdGF0dXNJZHMpfSwgc29ydE9uOiBWSVNVQUxfSUQsIHNvcnREZXNjZW5kaW5nOiAke3NvcnREZXNjQXJnKGFyZ3Muc29ydERlc2NlbmRpbmcpfSkge1xuICAgICAgbm9kZXMgeyAke09SREVSX05PREVfRklFTERTfSB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVzUGFnZVF1ZXJ5KGFyZ3M6IE9yZGVyUGFnZUFyZ3MgPSB7fSk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIHF1b3RlcyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhcmdzLmFmdGVyKX0ke3N0YXR1c0lkc0FyZyhhcmdzLnN0YXR1c0lkcyl9LCBzb3J0T246IFZJU1VBTF9JRCwgc29ydERlc2NlbmRpbmc6ICR7c29ydERlc2NBcmcoYXJncy5zb3J0RGVzY2VuZGluZyl9KSB7XG4gICAgICBub2RlcyB7ICR7T1JERVJfTk9ERV9GSUVMRFN9IH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qKlxuICogT3JkZXItbGlzdCB0b3RhbHM6IGhpc3RvcnktYmFja2ZpbGwgcHJvZ3Jlc3MgZGVub21pbmF0b3IgKyBmaW5hbFxuICogZ2FwIHZlcmlmaWNhdGlvbiAoREIgcm93IGNvdW50IHZzIFByaW50YXZvJ3MgdG90YWxOb2RlcykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvcmRlclRvdGFsc1F1ZXJ5KCk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIGludm9pY2VzKGZpcnN0OiAxKSB7IHRvdGFsTm9kZXMgfVxuICAgIHF1b3RlcyhmaXJzdDogMSkgeyB0b3RhbE5vZGVzIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjdXN0b21lcnNQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgY3VzdG9tZXJzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgIG5vZGVzIHtcbiAgICAgICAgaWRcbiAgICAgICAgY29tcGFueU5hbWVcbiAgICAgICAgb3duZXIgeyBpZCBlbWFpbCB9XG4gICAgICAgIHByaW1hcnlDb250YWN0IHsgaWQgZnVsbE5hbWUgZW1haWwgfVxuICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29udGFjdHNQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgY29udGFjdHMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgbm9kZXMge1xuICAgICAgICBpZFxuICAgICAgICBmdWxsTmFtZVxuICAgICAgICBlbWFpbFxuICAgICAgICBwaG9uZVxuICAgICAgICBjdXN0b21lciB7IGlkIGNvbXBhbnlOYW1lIH1cbiAgICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgICAgfVxuICAgICAgJHtQQUdFX0lORk99XG4gICAgfVxuICB9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXR1c2VzUGFnZVF1ZXJ5KGFmdGVyPzogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIHN0YXR1c2VzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgIG5vZGVzIHsgaWQgbmFtZSBjb2xvciBwb3NpdGlvbiB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG4vKiogQ2hlYXBlc3QgcG9zc2libGUgYXV0aGVudGljYXRlZCByZXF1ZXN0IFx1MjAxNCBwcm92ZXMgY3JlZHMgKyBjb25uZWN0aXZpdHkuICovXG5leHBvcnQgZnVuY3Rpb24gcHJvYmVRdWVyeSgpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHsgc3RhdHVzZXMoZmlyc3Q6IDEpIHsgbm9kZXMgeyBpZCBuYW1lIH0gfSB9YDtcbn1cblxuLypcbiAqIFx1MjUwMFx1MjUwMCBPcmRlciBkZXRhaWwgKGxpbmUgaXRlbXMgLyBpbXByaW50cykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gKiBDb21wbGV4aXR5IGNhcCBpcyAyNSwwMDAuIFRoZSBuZXN0ZWQgbGlzdCBjcmF3bCBmaXRzIGF0IDggb3JkZXJzL3BhZ2VcbiAqIHdpdGggdGhlIHNsaW0gZmllbGQgc2V0IGJlbG93IChwcm9iZWQgbGl2ZSBKdWx5IDIwMjYpOyB0aGUgc2luZ2xlLW9yZGVyXG4gKiBxdWVyeSB1c2VzIGdlbmVyb3VzIGxpbWl0cyBmb3IgdG9wcGluZyB1cCB0cnVuY2F0ZWQgY29ubmVjdGlvbnMuXG4gKi9cblxuLyoqIE9yZGVycyBwZXIgcGFnZSBmb3IgdGhlIG5lc3RlZCBkZXRhaWwgY3Jhd2wgKGNvbXBsZXhpdHktbGltaXRlZDogNiBcdTIyNDggMjJrIG9mIHRoZSAyNWsgY2FwOyA3ID0gMjUsNzIzIHJlamVjdGVkKS4gKi9cbmV4cG9ydCBjb25zdCBERVRBSUxfUEFHRV9TSVpFID0gNjtcbmNvbnN0IERFVEFJTF9HUk9VUFNfRklSU1QgPSA4O1xuY29uc3QgREVUQUlMX0xJTkVfSVRFTVNfRklSU1QgPSAyMDtcbmNvbnN0IERFVEFJTF9JTVBSSU5UU19GSVJTVCA9IDg7XG5cbmNvbnN0IExJTkVfSVRFTV9GSUVMRFMgPSBgXG4gIGlkXG4gIGl0ZW1OdW1iZXJcbiAgY29sb3JcbiAgZGVzY3JpcHRpb25cbiAgaXRlbXNcbiAgcHJpY2VcbiAgbWVyY2hcbiAgcHJvZHVjdFN0YXR1c1xuICBzaXplcyB7IHNpemUgY291bnQgfVxuICBjYXRlZ29yeSB7IGlkIG5hbWUgfVxuICBwcm9kdWN0IHsgaWQgYnJhbmQgfVxuYDtcblxuY29uc3QgSU1QUklOVF9GSUVMRFMgPSBgXG4gIGlkXG4gIGRldGFpbHNcbiAgcHJpY2luZ01hdHJpeENvbHVtbiB7IGlkIGNvbHVtbk5hbWUgbWF0cml4IHsgaWQgbmFtZSB9IH1cbiAgdHlwZU9mV29yayB7IGlkIG5hbWUgfVxuYDtcblxuZnVuY3Rpb24gbGluZUl0ZW1Hcm91cHNTZWxlY3Rpb24oXG4gIGdyb3Vwc0ZpcnN0OiBudW1iZXIsXG4gIGxpbmVJdGVtc0ZpcnN0OiBudW1iZXIsXG4gIGltcHJpbnRzRmlyc3Q6IG51bWJlcixcbiAgb3B0cz86IHsgd2l0aEdyb3VwQ3Vyc29yPzogYm9vbGVhbjsgYWZ0ZXI/OiBzdHJpbmcgfCBudWxsIH0sXG4pOiBzdHJpbmcge1xuICBjb25zdCBncm91cFBhZ2VJbmZvID0gb3B0cz8ud2l0aEdyb3VwQ3Vyc29yXG4gICAgPyBgcGFnZUluZm8geyBoYXNOZXh0UGFnZSBlbmRDdXJzb3IgfWBcbiAgICA6IGBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1gO1xuICByZXR1cm4gYGxpbmVJdGVtR3JvdXBzKGZpcnN0OiAke2dyb3Vwc0ZpcnN0fSR7YWZ0ZXJBcmcob3B0cz8uYWZ0ZXIpfSkge1xuICAgIG5vZGVzIHtcbiAgICAgIGlkXG4gICAgICBwb3NpdGlvblxuICAgICAgbGluZUl0ZW1zKGZpcnN0OiAke2xpbmVJdGVtc0ZpcnN0fSkge1xuICAgICAgICBub2RlcyB7ICR7TElORV9JVEVNX0ZJRUxEU30gfVxuICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgIH1cbiAgICAgIGltcHJpbnRzKGZpcnN0OiAke2ltcHJpbnRzRmlyc3R9KSB7XG4gICAgICAgIG5vZGVzIHsgJHtJTVBSSU5UX0ZJRUxEU30gfVxuICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgIH1cbiAgICB9XG4gICAgJHtncm91cFBhZ2VJbmZvfVxuICB9YDtcbn1cblxuZXhwb3J0IHR5cGUgT3JkZXJLaW5kID0gXCJpbnZvaWNlc1wiIHwgXCJxdW90ZXNcIjtcblxuLyoqXG4gKiBOZXN0ZWQgZGV0YWlsIGNyYXdsIHBhZ2U6IG9yZGVycyAoVklTVUFMX0lEIGRlc2MpIHdpdGggbGluZSBpdGVtIGdyb3VwcyxcbiAqIGxpbmUgaXRlbXMsIGFuZCBpbXByaW50cyBpbmxpbmUuIFRydW5jYXRpb24gZGV0ZWN0YWJsZSB2aWEgdGhlIG5lc3RlZFxuICogcGFnZUluZm8uaGFzTmV4dFBhZ2UgZmxhZ3MgXHUyMDE0IHRvcCB1cCB3aXRoIHNpbmdsZU9yZGVyRGV0YWlsUXVlcnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvcmRlckRldGFpbFBhZ2VRdWVyeShcbiAga2luZDogT3JkZXJLaW5kLFxuICBhZnRlcj86IHN0cmluZyB8IG51bGwsXG4gIG9wdHM6IHsgc29ydERlc2NlbmRpbmc/OiBib29sZWFuIH0gPSB7fSxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgICR7a2luZH0oZmlyc3Q6ICR7REVUQUlMX1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0sIHNvcnRPbjogVklTVUFMX0lELCBzb3J0RGVzY2VuZGluZzogJHtzb3J0RGVzY0FyZyhvcHRzLnNvcnREZXNjZW5kaW5nKX0pIHtcbiAgICAgIG5vZGVzIHtcbiAgICAgICAgaWRcbiAgICAgICAgdmlzdWFsSWRcbiAgICAgICAgdG90YWxRdWFudGl0eVxuICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICAgICR7bGluZUl0ZW1Hcm91cHNTZWxlY3Rpb24oREVUQUlMX0dST1VQU19GSVJTVCwgREVUQUlMX0xJTkVfSVRFTVNfRklSU1QsIERFVEFJTF9JTVBSSU5UU19GSVJTVCl9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG4vKipcbiAqIFNpbmdsZS1vcmRlciBkZXRhaWwgd2l0aCBnZW5lcm91cyBsaW1pdHMgKHRvcC11cCBmb3IgdHJ1bmNhdGVkIG9yZGVycykuXG4gKiAyMC80MC8xNSBwcm9iZWQgT0sgSnVseSAyMDI2OyAyNS81MC8yNSA9IGNvbXBsZXhpdHkgMjksNjM2ID4gMjVrIGNhcC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNpbmdsZU9yZGVyRGV0YWlsUXVlcnkoXG4gIGtpbmQ6IFwiaW52b2ljZVwiIHwgXCJxdW90ZVwiLFxuICBwcmludGF2b0lkOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICAke2tpbmR9KGlkOiAke2xpdChwcmludGF2b0lkKX0pIHtcbiAgICAgIGlkXG4gICAgICB2aXN1YWxJZFxuICAgICAgdG90YWxRdWFudGl0eVxuICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgICAgJHtsaW5lSXRlbUdyb3Vwc1NlbGVjdGlvbigyMCwgNDAsIDE1LCB7IHdpdGhHcm91cEN1cnNvcjogdHJ1ZSB9KX1cbiAgICB9XG4gIH1gO1xufVxuXG4vKiogRXhhY3Qtb3JkZXIgc3RhdHVzIGZlbmNlIHVzZWQgaW1tZWRpYXRlbHkgYmVmb3JlIFByaW50Tm9kZS9zdGF0dXMgd3JpdGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNpbmdsZU9yZGVyU3RhdHVzUXVlcnkoXG4gIGtpbmQ6IFwiaW52b2ljZVwiIHwgXCJxdW90ZVwiLFxuICBwcmludGF2b0lkOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICAke2tpbmR9KGlkOiAke2xpdChwcmludGF2b0lkKX0pIHtcbiAgICAgIGlkXG4gICAgICB2aXN1YWxJZFxuICAgICAgc3RhdHVzIHsgaWQgbmFtZSB9XG4gICAgfVxuICB9YDtcbn1cblxuLyoqXG4gKiBGb2xsb3ctdXAgcGFnZSBvZiBsaW5lSXRlbUdyb3VwcyBmb3Igb3JkZXJzIHdpdGggbW9yZSBncm91cHMgdGhhbiB0aGVcbiAqIHNpbmdsZS1vcmRlciBxdWVyeSdzIGZpcnN0IHBhZ2UgKHRoZSA+MjUtZ3JvdXAgdHJ1bmNhdGlvbiBmaXgpLiBTYW1lXG4gKiBnZW5lcm91cyBuZXN0ZWQgbGltaXRzOyBjdXJzb3IgY29udGludWVzIGZyb20gdGhlIHByZXZpb3VzIHBhZ2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvcmRlckdyb3Vwc1BhZ2VRdWVyeShcbiAga2luZDogXCJpbnZvaWNlXCIgfCBcInF1b3RlXCIsXG4gIHByaW50YXZvSWQ6IHN0cmluZyxcbiAgYWZ0ZXI6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgICR7a2luZH0oaWQ6ICR7bGl0KHByaW50YXZvSWQpfSkge1xuICAgICAgaWRcbiAgICAgICR7bGluZUl0ZW1Hcm91cHNTZWxlY3Rpb24oMTAsIDQwLCAxNSwgeyB3aXRoR3JvdXBDdXJzb3I6IHRydWUsIGFmdGVyIH0pfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qXG4gKiBcdTI1MDBcdTI1MDAgUHJvZHVjdC1zdGF0dXMgc3dlZXAgKHNsaW0pIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogUHJpbnRhdm8gZG9lcyBOT1QgYnVtcCBhbiBvcmRlcidzIHVwZGF0ZWRBdCB3aGVuIGEgbGluZSBpdGVtJ3NcbiAqIHByb2R1Y3RTdGF0dXMgY2hhbmdlcyAodmVyaWZpZWQgbGl2ZSBKdWx5IDIwMjYpLCBzbyB0aGUgaGFzaC1iYXNlZCBsaXN0XG4gKiBjcmF3bCBuZXZlciBub3RpY2VzLiBUaGlzIHNsaW0gcGFnZSBmZXRjaGVzIE9OTFkgbGluZSBpdGVtIGlkICtcbiAqIHByb2R1Y3RTdGF0dXMgc28gdGhlIHN5bmMgY2FuIGRpZmYgYWdhaW5zdCB0aGUgREIgYW5kIHJlLXB1bGwgZGV0YWlsc1xuICogZm9yIG1pc21hdGNoZWQgb3JkZXJzLiBOZXN0aW5nIGxpbWl0cyAoMjUgaW52b2ljZXMgXHUwMEQ3IDUgZ3JvdXBzIFx1MDBENyA4IGl0ZW1zKVxuICogYXJlIHRoZSBsZWdhY3kgUE8gQnVpbGRlcidzIHByb3Zlbi1zYWZlIGNvbXBsZXhpdHkgYnVkZ2V0IFx1MjAxNCBkbyBOT1QgcmFpc2UuXG4gKi9cblxuY29uc3QgU1dFRVBfR1JPVVBTX0ZJUlNUID0gNTtcbmNvbnN0IFNXRUVQX0xJTkVfSVRFTVNfRklSU1QgPSA4O1xuXG5leHBvcnQgZnVuY3Rpb24gcHJvZHVjdFN0YXR1c1N3ZWVwUGFnZVF1ZXJ5KGFmdGVyPzogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIGludm9pY2VzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0sIHNvcnRPbjogVklTVUFMX0lELCBzb3J0RGVzY2VuZGluZzogdHJ1ZSkge1xuICAgICAgbm9kZXMge1xuICAgICAgICBpZFxuICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICAgIGxpbmVJdGVtR3JvdXBzKGZpcnN0OiAke1NXRUVQX0dST1VQU19GSVJTVH0pIHtcbiAgICAgICAgICBub2RlcyB7XG4gICAgICAgICAgICBpZFxuICAgICAgICAgICAgbGluZUl0ZW1zKGZpcnN0OiAke1NXRUVQX0xJTkVfSVRFTVNfRklSU1R9KSB7XG4gICAgICAgICAgICAgIG5vZGVzIHsgaWQgcHJvZHVjdFN0YXR1cyB9XG4gICAgICAgICAgICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgJHtQQUdFX0lORk99XG4gICAgfVxuICB9YDtcbn1cblxuLypcbiAqIFx1MjUwMFx1MjUwMCBQTyBwdXNoIHdyaXRlIG11dGF0aW9ucyAoUDNjKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIFZlcmlmaWVkIHZpYSBsaXZlIGludHJvc3BlY3Rpb24gSnVseSAyMDI2OlxuICogLSBsaW5lSXRlbVVwZGF0ZShpZDogSUQhLCBpbnB1dDogTGluZUl0ZW1JbnB1dCEpIFx1MjAxNCBwb3NpdGlvbiBpcyBSRVFVSVJFRFxuICogICBpbiB0aGUgaW5wdXQgb3IgdGhlIG11dGF0aW9uIGZhaWxzOyBwcm9kdWN0U3RhdHVzIGlzIHRoZSBMaW5lSXRlbVN0YXR1c1xuICogICBlbnVtIChuZWVkX29yZGVyaW5nLCBhdHRhY2hlZF90b19wbywgb3JkZXJlZCwgYXJyaXZlZCxcbiAqICAgcGFydGlhbGx5X3JlY2VpdmVkLCByZWNlaXZlZCwgaW4pOyBzaXplcyBpcyBbTGluZUl0ZW1TaXplQ291bnRJbnB1dCFdXG4gKiAgIHdpdGggc2l6ZSBiZWluZyB0aGUgTGluZUl0ZW1TaXplIGVudW0gKHNpemVfcyBcdTIwMjYgc2l6ZV81dCkuXG4gKiAtIHByb2R1Y3Rpb25GaWxlQ3JlYXRlKHBhcmVudElkOiBJRCEsIHB1YmxpY0ZpbGVVcmw6IFN0cmluZyEpIFx1MjAxNCBQcmludGF2b1xuICogICBmZXRjaGVzIHRoZSBmaWxlIGZyb20gdGhlIFVSTCBhc3luY2hyb25vdXNseSBhZnRlciB0aGUgbXV0YXRpb24uXG4gKi9cblxuLyoqIExpbmVJdGVtU2l6ZSBlbnVtIHZhbHVlcyBhY2NlcHRlZCBieSBsaW5lSXRlbVVwZGF0ZSAoaW50cm9zcGVjdGVkIGxpdmUpLiAqL1xuZXhwb3J0IGNvbnN0IFBSSU5UQVZPX1NJWkVfRU5VTSA9IG5ldyBTZXQoW1xuICBcInNpemVfeXhzXCIsIFwic2l6ZV95c1wiLCBcInNpemVfeW1cIiwgXCJzaXplX3lsXCIsIFwic2l6ZV95eGxcIixcbiAgXCJzaXplX3hzXCIsIFwic2l6ZV9zXCIsIFwic2l6ZV9tXCIsIFwic2l6ZV9sXCIsIFwic2l6ZV94bFwiLFxuICBcInNpemVfMnhsXCIsIFwic2l6ZV8zeGxcIiwgXCJzaXplXzR4bFwiLCBcInNpemVfNXhsXCIsIFwic2l6ZV82eGxcIixcbiAgXCJzaXplX290aGVyXCIsXG4gIFwic2l6ZV82bVwiLCBcInNpemVfMTJtXCIsIFwic2l6ZV8xOG1cIiwgXCJzaXplXzI0bVwiLFxuICBcInNpemVfMnRcIiwgXCJzaXplXzN0XCIsIFwic2l6ZV80dFwiLCBcInNpemVfNXRcIixcbl0pO1xuXG4vKipcbiAqIE1hcCBhIEh1Yi1ub3JtYWxpemVkIHNpemUgbGFiZWwgKHN0cmlwcGVkIGBzaXplX2AgcHJlZml4LCB1cHBlcmNhc2VkIFx1MjAxNFxuICogZS5nLiBcIk1cIiwgXCIyWExcIiwgXCI2TVwiKSBiYWNrIHRvIFByaW50YXZvJ3MgTGluZUl0ZW1TaXplIGVudW0uIFJldHVybnMgbnVsbFxuICogZm9yIGFueXRoaW5nIHRoYXQgZG9lcyBub3QgbWFwIGV4YWN0bHkgKGUuZy4gdGhlIHN5bnRoZXRpYyBcIk9TRkFcIiByb3dzIHRoZVxuICogY2FydCBhZGRzIGZvciBzaXplLWxlc3MgbGluZXMpIFx1MjAxNCBjYWxsZXJzIG11c3QgdGhlbiBsZWF2ZSBzaXplcyB1bnRvdWNoZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0xpbmVJdGVtU2l6ZUVudW0obGFiZWw6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBjYW5kaWRhdGUgPSBgc2l6ZV8ke2xhYmVsLnRyaW0oKS50b0xvd2VyQ2FzZSgpfWA7XG4gIHJldHVybiBQUklOVEFWT19TSVpFX0VOVU0uaGFzKGNhbmRpZGF0ZSkgPyBjYW5kaWRhdGUgOiBudWxsO1xufVxuXG4vKiogTGluZSBpdGVtIHN0YXR1c2VzIHRoYXQgbWVhbiBcInRoZSBnb29kcyBhcmUgYWxyZWFkeSBvcmRlcmVkL2hlcmVcIiBcdTIwMTQgYSBwdXNoIG11c3Qgc2tpcCB0aGVzZS4gKi9cbmV4cG9ydCBjb25zdCBPUkRFUkVEX09SX0xBVEVSX1NUQVRVU0VTID0gbmV3IFNldChbXG4gIFwib3JkZXJlZFwiLFxuICBcImFycml2ZWRcIixcbiAgXCJwYXJ0aWFsbHlfcmVjZWl2ZWRcIixcbiAgXCJyZWNlaXZlZFwiLFxuXSk7XG5cbi8qKiBTbGltIHNpbmdsZSBsaW5lIGl0ZW0gZmV0Y2ggdXNlZCBieSB0aGUgUE8gcHVzaCB0byBkaWZmIGJlZm9yZSB3cml0aW5nLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBvUHVzaExpbmVJdGVtUXVlcnkobGluZUl0ZW1JZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgbGluZUl0ZW0oaWQ6ICR7bGl0KGxpbmVJdGVtSWQpfSkge1xuICAgICAgaWRcbiAgICAgIHBvc2l0aW9uXG4gICAgICBwcm9kdWN0U3RhdHVzXG4gICAgICBpdGVtTnVtYmVyXG4gICAgICBjb2xvclxuICAgICAgc2l6ZXMgeyBzaXplIGNvdW50IH1cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIExpbmVJdGVtVXBkYXRlSW5wdXQge1xuICAvKiogUkVRVUlSRUQgYnkgUHJpbnRhdm8ncyBMaW5lSXRlbUlucHV0LiAqL1xuICBwb3NpdGlvbjogbnVtYmVyO1xuICAvKipcbiAgICogTGluZUl0ZW1TdGF0dXMgZW51bSB2YWx1ZSwgZS5nLiBcIm9yZGVyZWRcIiAodW5xdW90ZWQgZW51bSBsaXRlcmFsKS5cbiAgICogYG51bGxgIGV4cGxpY2l0bHkgY2xlYXJzIHRoZSBzdGF0dXM7IGB1bmRlZmluZWRgIGxlYXZlcyBpdCB1bnRvdWNoZWQuXG4gICAqL1xuICBwcm9kdWN0U3RhdHVzPzogc3RyaW5nIHwgbnVsbDtcbiAgaXRlbU51bWJlcj86IHN0cmluZztcbiAgY29sb3I/OiBzdHJpbmc7XG4gIC8qKiBQYWlycyBvZiAoTGluZUl0ZW1TaXplIGVudW0gdmFsdWUsIGNvdW50KS4gRW51bSB2YWx1ZXMgbXVzdCBjb21lIGZyb20gUFJJTlRBVk9fU0laRV9FTlVNLiAqL1xuICBzaXplcz86IEFycmF5PHsgc2l6ZTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH0+O1xufVxuXG5jb25zdCBFTlVNX0xJVEVSQUwgPSAvXlthLXpfXVthLXowLTlfXSokLztcblxuZnVuY3Rpb24gZW51bUxpdCh2YWx1ZTogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIUVOVU1fTElURVJBTC50ZXN0KHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCAke3doYXR9IGVudW0gdmFsdWU6ICR7SlNPTi5zdHJpbmdpZnkodmFsdWUpfWApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxpbmVJdGVtVXBkYXRlTXV0YXRpb24oXG4gIGxpbmVJdGVtSWQ6IHN0cmluZyxcbiAgaW5wdXQ6IExpbmVJdGVtVXBkYXRlSW5wdXQsXG4pOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbYHBvc2l0aW9uOiAke01hdGgudHJ1bmMoaW5wdXQucG9zaXRpb24pfWBdO1xuICBpZiAoaW5wdXQucHJvZHVjdFN0YXR1cyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcGFydHMucHVzaChcbiAgICAgIGlucHV0LnByb2R1Y3RTdGF0dXMgPT09IG51bGxcbiAgICAgICAgPyBcInByb2R1Y3RTdGF0dXM6IG51bGxcIlxuICAgICAgICA6IGBwcm9kdWN0U3RhdHVzOiAke2VudW1MaXQoaW5wdXQucHJvZHVjdFN0YXR1cywgXCJMaW5lSXRlbVN0YXR1c1wiKX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKGlucHV0Lml0ZW1OdW1iZXIgIT09IHVuZGVmaW5lZCkgcGFydHMucHVzaChgaXRlbU51bWJlcjogJHtsaXQoaW5wdXQuaXRlbU51bWJlcil9YCk7XG4gIGlmIChpbnB1dC5jb2xvciAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGBjb2xvcjogJHtsaXQoaW5wdXQuY29sb3IpfWApO1xuICBpZiAoaW5wdXQuc2l6ZXMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHNpemVMaXRzID0gaW5wdXQuc2l6ZXMubWFwKFxuICAgICAgKHMpID0+IGB7IHNpemU6ICR7ZW51bUxpdChzLnNpemUsIFwiTGluZUl0ZW1TaXplXCIpfSwgY291bnQ6ICR7TWF0aC50cnVuYyhzLmNvdW50KX0gfWAsXG4gICAgKTtcbiAgICBwYXJ0cy5wdXNoKGBzaXplczogWyR7c2l6ZUxpdHMuam9pbihcIiwgXCIpfV1gKTtcbiAgfVxuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICBsaW5lSXRlbVVwZGF0ZShpZDogJHtsaXQobGluZUl0ZW1JZCl9LCBpbnB1dDogeyAke3BhcnRzLmpvaW4oXCIsIFwiKX0gfSkge1xuICAgICAgaWRcbiAgICAgIHByb2R1Y3RTdGF0dXNcbiAgICB9XG4gIH1gO1xufVxuXG4vKipcbiAqIFJlYWQgY3VycmVudCBncm91cCBwb3NpdGlvbnMgYmVmb3JlIGFwcGVuZGluZyBhIGNhbGN1bGF0b3ItY3JlYXRlZCBncm91cC5cbiAqIEJvdGggUXVvdGUgYW5kIEludm9pY2UgZXhwb3NlIGxpbmVJdGVtR3JvdXBzOyBhbGlhcyB0aGUgc2VsZWN0ZWQgcm9vdCB0byBhXG4gKiBzdGFibGUgcmVzcG9uc2Uga2V5IHNvIGNhbGxlcnMgbmV2ZXIgbmVlZCB0byB0cnVzdCBhIGNsaWVudC1zdXBwbGllZCB0eXBlLlxuICogVGhlIGNhbGxlciBmYWlscyBjbG9zZWQgaWYgUHJpbnRhdm8gcmVwb3J0cyBtb3JlIHRoYW4gMTAwIGdyb3Vwcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyTGluZUl0ZW1Hcm91cFBvc2l0aW9uc1F1ZXJ5KFxuICBvcmRlcklkOiBzdHJpbmcsXG4gIG9yZGVyVHlwZTogXCJpbnZvaWNlXCIgfCBcInF1b3RlXCIsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBvcmRlcjogJHtvcmRlclR5cGV9KGlkOiAke2xpdChvcmRlcklkKX0pIHtcbiAgICAgIGlkXG4gICAgICB2aXN1YWxJZFxuICAgICAgbGluZUl0ZW1Hcm91cHMoZmlyc3Q6IDEwMCkge1xuICAgICAgICBub2RlcyB7IGlkIHBvc2l0aW9uIH1cbiAgICAgICAgcGFnZUluZm8geyBoYXNOZXh0UGFnZSB9XG4gICAgICB9XG4gICAgfVxuICB9YDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDYWxjdWxhdG9yTGluZUl0ZW1DcmVhdGVJbnB1dCB7XG4gIHBvc2l0aW9uOiBudW1iZXI7XG4gIGNhdGVnb3J5SWQ6IHN0cmluZztcbiAgaXRlbU51bWJlcjogc3RyaW5nO1xuICBjb2xvcjogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xufVxuXG4vKipcbiAqIEFwcGVuZHMgb25lIG5ldyBsaW5lLWl0ZW0gZ3JvdXAgY29udGFpbmluZyBvbmUgcXVvdGVkIGdhcm1lbnQuXG4gKiBTaGFwZSB2ZXJpZmllZCB0aHJvdWdoIGxpdmUgUHJpbnRhdm8gc2NoZW1hIGludHJvc3BlY3Rpb24gQXVndXN0IDIwMjY6XG4gKiBsaW5lSXRlbUdyb3VwQ3JlYXRlKHBhcmVudElkOiBJRCEsIGlucHV0OiBMaW5lSXRlbUdyb3VwQ3JlYXRlSW5wdXQhKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbGN1bGF0b3JMaW5lSXRlbUdyb3VwQ3JlYXRlTXV0YXRpb24oXG4gIHBhcmVudElkOiBzdHJpbmcsXG4gIGlucHV0OiBDYWxjdWxhdG9yTGluZUl0ZW1DcmVhdGVJbnB1dCxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIGxpbmVJdGVtR3JvdXBDcmVhdGUoXG4gICAgICBwYXJlbnRJZDogJHtsaXQocGFyZW50SWQpfVxuICAgICAgaW5wdXQ6IHtcbiAgICAgICAgcG9zaXRpb246ICR7TWF0aC50cnVuYyhpbnB1dC5wb3NpdGlvbil9XG4gICAgICAgIGxpbmVJdGVtczogW3tcbiAgICAgICAgICBwb3NpdGlvbjogMFxuICAgICAgICAgIGNhdGVnb3J5OiB7IGlkOiAke2xpdChpbnB1dC5jYXRlZ29yeUlkKX0gfVxuICAgICAgICAgIGl0ZW1OdW1iZXI6ICR7bGl0KGlucHV0Lml0ZW1OdW1iZXIpfVxuICAgICAgICAgIGNvbG9yOiAke2xpdChpbnB1dC5jb2xvcil9XG4gICAgICAgICAgZGVzY3JpcHRpb246ICR7bGl0KGlucHV0LmRlc2NyaXB0aW9uKX1cbiAgICAgICAgICBwcm9kdWN0U3RhdHVzOiBuZWVkX29yZGVyaW5nXG4gICAgICAgICAgdGF4ZWQ6IHRydWVcbiAgICAgICAgfV1cbiAgICAgIH1cbiAgICApIHtcbiAgICAgIGlkXG4gICAgICBwb3NpdGlvblxuICAgICAgbGluZUl0ZW1zKGZpcnN0OiAxMCkge1xuICAgICAgICBub2RlcyB7XG4gICAgICAgICAgaWRcbiAgICAgICAgICBpdGVtTnVtYmVyXG4gICAgICAgICAgY29sb3JcbiAgICAgICAgICBkZXNjcmlwdGlvblxuICAgICAgICAgIGNhdGVnb3J5IHsgaWQgbmFtZSB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFF1b3RlQ3JlYXRlTGluZUl0ZW0ge1xuICBwb3NpdGlvbjogbnVtYmVyO1xuICBpdGVtTnVtYmVyOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIGNvbG9yOiBzdHJpbmc7XG4gIHByaWNlOiBudW1iZXI7XG4gIG1hcmt1cFBlcmNlbnRhZ2U6IG51bWJlcjtcbiAgc2l6ZXM6IEFycmF5PHsgc2l6ZTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH0+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFF1b3RlQ3JlYXRlSW1wcmludCB7XG4gIGRldGFpbHM6IHN0cmluZztcbiAgcHJpY2luZ01hdHJpeENvbHVtbklkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUXVvdGVDcmVhdGVMaW5lSXRlbUdyb3VwIHtcbiAgcG9zaXRpb246IG51bWJlcjtcbiAgbGluZUl0ZW1zOiBRdW90ZUNyZWF0ZUxpbmVJdGVtW107XG4gIGltcHJpbnRzOiBRdW90ZUNyZWF0ZUltcHJpbnRbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBRdW90ZUNyZWF0ZUlucHV0IHtcbiAgY29udGFjdElkOiBzdHJpbmc7XG4gIGN1c3RvbWVyRHVlQXQ6IHN0cmluZztcbiAgZHVlQXQ6IHN0cmluZztcbiAgbmlja25hbWU6IHN0cmluZztcbiAgY3VzdG9tZXJOb3RlPzogc3RyaW5nO1xuICBwcm9kdWN0aW9uTm90ZT86IHN0cmluZztcbiAgbGluZUl0ZW1Hcm91cHM6IFF1b3RlQ3JlYXRlTGluZUl0ZW1Hcm91cFtdO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBzaW5nbGUgbmVzdGVkIFByaW50YXZvIHF1b3RlQ3JlYXRlIG11dGF0aW9uLiBJbnB1dCBzaGFwZSB3YXNcbiAqIHZlcmlmaWVkIHRocm91Z2ggbGl2ZSBzY2hlbWEgaW50cm9zcGVjdGlvbiBpbiBBdWd1c3QgMjAyNi4gRXZlcnkgZW51bSB2YWx1ZVxuICogaXMgdmFsaWRhdGVkIGJlZm9yZSBpdCBpcyBlbWl0dGVkIGFzIGFuIHVucXVvdGVkIEdyYXBoUUwgbGl0ZXJhbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHF1b3RlQ3JlYXRlTXV0YXRpb24oaW5wdXQ6IFF1b3RlQ3JlYXRlSW5wdXQpOiBzdHJpbmcge1xuICBjb25zdCBncm91cHMgPSBpbnB1dC5saW5lSXRlbUdyb3Vwcy5tYXAoKGdyb3VwKSA9PiB7XG4gICAgY29uc3QgbGluZUl0ZW1zID0gZ3JvdXAubGluZUl0ZW1zLm1hcCgoaXRlbSkgPT4ge1xuICAgICAgY29uc3Qgc2l6ZXMgPSBpdGVtLnNpemVzLm1hcChcbiAgICAgICAgKHNpemUpID0+XG4gICAgICAgICAgYHsgc2l6ZTogJHtlbnVtTGl0KHNpemUuc2l6ZSwgXCJMaW5lSXRlbVNpemVcIil9LCBjb3VudDogJHtNYXRoLnRydW5jKHNpemUuY291bnQpfSB9YCxcbiAgICAgICk7XG4gICAgICByZXR1cm4gYHsgcG9zaXRpb246ICR7TWF0aC50cnVuYyhpdGVtLnBvc2l0aW9uKX0sIGl0ZW1OdW1iZXI6ICR7bGl0KGl0ZW0uaXRlbU51bWJlcil9LCBkZXNjcmlwdGlvbjogJHtsaXQoaXRlbS5kZXNjcmlwdGlvbil9LCBjb2xvcjogJHtsaXQoaXRlbS5jb2xvcil9LCBwcmljZTogJHtOdW1iZXIoaXRlbS5wcmljZSkudG9GaXhlZCgyKX0sIG1hcmt1cFBlcmNlbnRhZ2U6ICR7TnVtYmVyKGl0ZW0ubWFya3VwUGVyY2VudGFnZSkudG9GaXhlZCg0KX0sIHByb2R1Y3RTdGF0dXM6IG5lZWRfb3JkZXJpbmcsIHRheGVkOiB0cnVlLCBzaXplczogWyR7c2l6ZXMuam9pbihcIiwgXCIpfV0gfWA7XG4gICAgfSk7XG4gICAgY29uc3QgaW1wcmludHMgPSBncm91cC5pbXByaW50cy5tYXAoKGltcHJpbnQpID0+IHtcbiAgICAgIHJldHVybiBgeyBkZXRhaWxzOiAke2xpdChpbXByaW50LmRldGFpbHMpfSwgcHJpY2luZ01hdHJpeENvbHVtbjogeyBpZDogJHtsaXQoaW1wcmludC5wcmljaW5nTWF0cml4Q29sdW1uSWQpfSB9IH1gO1xuICAgIH0pO1xuICAgIHJldHVybiBgeyBwb3NpdGlvbjogJHtNYXRoLnRydW5jKGdyb3VwLnBvc2l0aW9uKX0sIGxpbmVJdGVtczogWyR7bGluZUl0ZW1zLmpvaW4oXCIsIFwiKX1dLCBpbXByaW50czogWyR7aW1wcmludHMuam9pbihcIiwgXCIpfV0gfWA7XG4gIH0pO1xuXG4gIGNvbnN0IHBhcnRzID0gW1xuICAgIGBjb250YWN0OiB7IGlkOiAke2xpdChpbnB1dC5jb250YWN0SWQpfSB9YCxcbiAgICBgY3VzdG9tZXJEdWVBdDogJHtsaXQoaW5wdXQuY3VzdG9tZXJEdWVBdCl9YCxcbiAgICBgZHVlQXQ6ICR7bGl0KGlucHV0LmR1ZUF0KX1gLFxuICAgIGBuaWNrbmFtZTogJHtsaXQoaW5wdXQubmlja25hbWUpfWAsXG4gICAgYGxpbmVJdGVtR3JvdXBzOiBbJHtncm91cHMuam9pbihcIiwgXCIpfV1gLFxuICBdO1xuICBpZiAoaW5wdXQuY3VzdG9tZXJOb3RlKSBwYXJ0cy5wdXNoKGBjdXN0b21lck5vdGU6ICR7bGl0KGlucHV0LmN1c3RvbWVyTm90ZSl9YCk7XG4gIGlmIChpbnB1dC5wcm9kdWN0aW9uTm90ZSkge1xuICAgIHBhcnRzLnB1c2goYHByb2R1Y3Rpb25Ob3RlOiAke2xpdChpbnB1dC5wcm9kdWN0aW9uTm90ZSl9YCk7XG4gIH1cblxuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICBxdW90ZUNyZWF0ZShpbnB1dDogeyAke3BhcnRzLmpvaW4oXCIsIFwiKX0gfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICBwdWJsaWNVcmxcbiAgICAgIG5pY2tuYW1lXG4gICAgICB0b3RhbFxuICAgICAgY3VzdG9tZXJEdWVBdFxuICAgICAgZHVlQXRcbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJvZHVjdGlvbkZpbGVDcmVhdGVNdXRhdGlvbihcbiAgcGFyZW50SWQ6IHN0cmluZyxcbiAgcHVibGljRmlsZVVybDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBtdXRhdGlvbiB7XG4gICAgcHJvZHVjdGlvbkZpbGVDcmVhdGUocGFyZW50SWQ6ICR7bGl0KHBhcmVudElkKX0sIHB1YmxpY0ZpbGVVcmw6ICR7bGl0KHB1YmxpY0ZpbGVVcmwpfSkge1xuICAgICAgaWRcbiAgICAgIGZpbGVVcmxcbiAgICB9XG4gIH1gO1xufVxuXG4vKipcbiAqIENoYW5nZSBhbiBvcmRlcidzIHN0YXR1cy4gYHBhcmVudElkYCBpcyB0aGUgaW52b2ljZS9xdW90ZSBHcmFwaFFMIGlkO1xuICogcmV0dXJucyBPcmRlclVuaW9uLCBzbyB0aGUgc2VsZWN0aW9uIG5lZWRzIGlubGluZSBmcmFnbWVudHMgKHZlcmlmaWVkIHZpYVxuICogaW50cm9zcGVjdGlvbjogc3RhdHVzVXBkYXRlKHBhcmVudElkOiBJRCEsIHN0YXR1c0lkOiBJRCEpOiBPcmRlclVuaW9uKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXR1c1VwZGF0ZU11dGF0aW9uKHBhcmVudElkOiBzdHJpbmcsIHN0YXR1c0lkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICBzdGF0dXNVcGRhdGUocGFyZW50SWQ6ICR7bGl0KHBhcmVudElkKX0sIHN0YXR1c0lkOiAke2xpdChzdGF0dXNJZCl9KSB7XG4gICAgICAuLi4gb24gSW52b2ljZSB7IGlkIHN0YXR1cyB7IGlkIG5hbWUgfSB9XG4gICAgICAuLi4gb24gUXVvdGUgeyBpZCBzdGF0dXMgeyBpZCBuYW1lIH0gfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qXG4gKiBcdTI1MDBcdTI1MDAgVHJhbnNhY3Rpb25zIChjYXNoLWJhc2lzIHBheW1lbnRzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIFJvb3QgYHRyYW5zYWN0aW9uc2AgaGFzIHBhZ2luYXRpb24gb25seSAobm8gZGF0ZSBmaWx0ZXIpLCBuZXdlc3QtZmlyc3QuXG4gKiBUcmFuc2FjdGlvblVuaW9uIG1lbWJlcnMgYWxsIHNoYXJlIHRoZSBzYW1lIGNvcmUgZmllbGRzOyBQYXltZW50IGFkZHNcbiAqIGBzb3VyY2VgLCBQYXltZW50RGlzcHV0ZSBhZGRzIGBzdGF0dXNgLlxuICovXG5cbmNvbnN0IFRSQU5TQUNUSU9OX0NPUkVfRklFTERTID0gYFxuICBpZFxuICBhbW91bnRcbiAgY2F0ZWdvcnlcbiAgZGVzY3JpcHRpb25cbiAgcHJvY2Vzc2luZ1xuICB0cmFuc2FjdGlvbkRhdGVcbiAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICB0cmFuc2FjdGVkRm9yIHtcbiAgICBfX3R5cGVuYW1lXG4gICAgLi4uIG9uIEludm9pY2UgeyBpZCB2aXN1YWxJZCB9XG4gICAgLi4uIG9uIFF1b3RlIHsgaWQgdmlzdWFsSWQgfVxuICAgIC4uLiBvbiBNZXJjaE9yZGVyIHsgaWQgfVxuICB9XG5gO1xuXG5leHBvcnQgZnVuY3Rpb24gdHJhbnNhY3Rpb25zUGFnZVF1ZXJ5KGFmdGVyPzogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIHRyYW5zYWN0aW9ucyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhZnRlcil9KSB7XG4gICAgICBub2RlcyB7XG4gICAgICAgIF9fdHlwZW5hbWVcbiAgICAgICAgLi4uIG9uIFBheW1lbnQgeyAke1RSQU5TQUNUSU9OX0NPUkVfRklFTERTfSBzb3VyY2UgfVxuICAgICAgICAuLi4gb24gUmVmdW5kIHsgJHtUUkFOU0FDVElPTl9DT1JFX0ZJRUxEU30gfVxuICAgICAgICAuLi4gb24gUmV0dXJuIHsgJHtUUkFOU0FDVElPTl9DT1JFX0ZJRUxEU30gfVxuICAgICAgICAuLi4gb24gVm9pZCB7ICR7VFJBTlNBQ1RJT05fQ09SRV9GSUVMRFN9IH1cbiAgICAgICAgLi4uIG9uIFBheW1lbnREaXNwdXRlIHsgJHtUUkFOU0FDVElPTl9DT1JFX0ZJRUxEU30gc3RhdHVzIH1cbiAgICAgIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qXG4gKiBcdTI1MDBcdTI1MDAgVGFza3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gKiBWZXJpZmllZCB2aWEgbGl2ZSBpbnRyb3NwZWN0aW9uICsgbGl2ZSB0ZXN0IChKdWx5IDIwMjYpOlxuICogLSB0YXNrcyhmaXJzdCwgYWZ0ZXIsIGFzc2lnbmVlSWQsIGNvbXBsZXRlZCwgZHVlQWZ0ZXIsIGR1ZUJlZm9yZSwgc29ydE9uLFxuICogICBzb3J0RGVzY2VuZGluZyk7IE5PIHVwZGF0ZWRBZnRlciBmaWx0ZXIgXHUyMTkyIHN5bmMgPSBmdWxsIG9wZW4tdGFzayByZS1zY2FuLlxuICogLSB0YXNrYWJsZTogQ3VzdG9tZXIgfCBJbnZvaWNlIHwgUXVvdGU7IG51bGwgPSBzdGFuZGFsb25lIFwiY2FsZW5kYXJcIiB0YXNrLlxuICogLSB0YXNrVXBkYXRlIGhhcyBNRVJHRSBzZW1hbnRpY3M6IHNlbmRpbmcgb25seSB7IGNvbXBsZXRlZCB9IHByZXNlcnZlc1xuICogICBuYW1lL2R1ZUF0L2Fzc2lnbmVkVG8gKGxpdmUtdmVyaWZpZWQgb24gYSB0aHJvd2F3YXkgdGFzaykuXG4gKiAtIHRhc2tEZWxldGUgcmV0dXJucyBEZWxldGVkSUQgYW5kIHJlcXVpcmVzIGEgc2VsZWN0aW9uIHNldC5cbiAqL1xuXG5jb25zdCBUQVNLX05PREVfRklFTERTID0gYFxuICBpZFxuICBuYW1lXG4gIGR1ZUF0XG4gIGNvbXBsZXRlZFxuICBjb21wbGV0ZWRBdFxuICBhc3NpZ25lZFRvIHsgaWQgbmFtZSBlbWFpbCB9XG4gIHRhc2thYmxlIHtcbiAgICBfX3R5cGVuYW1lXG4gICAgLi4uIG9uIEludm9pY2UgeyBpZCB2aXN1YWxJZCBuaWNrbmFtZSBjb250YWN0IHsgZnVsbE5hbWUgY3VzdG9tZXIgeyBjb21wYW55TmFtZSB9IH0gfVxuICAgIC4uLiBvbiBRdW90ZSB7IGlkIHZpc3VhbElkIG5pY2tuYW1lIGNvbnRhY3QgeyBmdWxsTmFtZSBjdXN0b21lciB7IGNvbXBhbnlOYW1lIH0gfSB9XG4gICAgLi4uIG9uIEN1c3RvbWVyIHsgaWQgfVxuICB9XG4gIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbmA7XG5cbmV4cG9ydCBmdW5jdGlvbiB0YXNrc1BhZ2VRdWVyeShhcmdzOiB7XG4gIGFmdGVyPzogc3RyaW5nIHwgbnVsbDtcbiAgY29tcGxldGVkPzogYm9vbGVhbjtcbn0gPSB7fSk6IHN0cmluZyB7XG4gIGNvbnN0IGNvbXBsZXRlZEFyZyA9XG4gICAgYXJncy5jb21wbGV0ZWQgIT09IHVuZGVmaW5lZCA/IGAsIGNvbXBsZXRlZDogJHthcmdzLmNvbXBsZXRlZH1gIDogXCJcIjtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgdGFza3MoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYXJncy5hZnRlcil9JHtjb21wbGV0ZWRBcmd9KSB7XG4gICAgICBub2RlcyB7ICR7VEFTS19OT0RFX0ZJRUxEU30gfVxuICAgICAgJHtQQUdFX0lORk99XG4gICAgfVxuICB9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRhc2tEZXRhaWxRdWVyeSh0YXNrSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIHRhc2soaWQ6ICR7bGl0KHRhc2tJZCl9KSB7ICR7VEFTS19OT0RFX0ZJRUxEU30gfVxuICB9YDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUYXNrV3JpdGVJbnB1dCB7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIC8qKiBJU084NjAxIHRpbWVzdGFtcCBvciBudWxsIHNlbWFudGljcyBub3Qgc3VwcG9ydGVkIFx1MjAxNCBvbWl0IHRvIGtlZXAuICovXG4gIGR1ZUF0Pzogc3RyaW5nO1xuICBjb21wbGV0ZWQ/OiBib29sZWFuO1xuICAvKiogUHJpbnRhdm8gVXNlci5pZCBcdTIwMTQgb21pdCB0byBrZWVwLCBzZXQgdG8gYXNzaWduLiAqL1xuICBhc3NpZ25lZFRvSWQ/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIHRhc2tJbnB1dFBhcnRzKGlucHV0OiBUYXNrV3JpdGVJbnB1dCk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoaW5wdXQubmFtZSAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGBuYW1lOiAke2xpdChpbnB1dC5uYW1lKX1gKTtcbiAgaWYgKGlucHV0LmR1ZUF0ICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYGR1ZUF0OiAke2xpdChpbnB1dC5kdWVBdCl9YCk7XG4gIGlmIChpbnB1dC5jb21wbGV0ZWQgIT09IHVuZGVmaW5lZCkgcGFydHMucHVzaChgY29tcGxldGVkOiAke2lucHV0LmNvbXBsZXRlZH1gKTtcbiAgaWYgKGlucHV0LmFzc2lnbmVkVG9JZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcGFydHMucHVzaChgYXNzaWduZWRUbzogeyBpZDogJHtsaXQoaW5wdXQuYXNzaWduZWRUb0lkKX0gfWApO1xuICB9XG4gIHJldHVybiBwYXJ0cy5qb2luKFwiLCBcIik7XG59XG5cbi8qKiBDcmVhdGVzIGEgU1RBTkRBTE9ORSAoY2FsZW5kYXIpIHRhc2sgXHUyMDE0IG5vIHRhc2thYmxlIG9uIHB1cnBvc2UuICovXG5leHBvcnQgZnVuY3Rpb24gdGFza0NyZWF0ZU11dGF0aW9uKGlucHV0OiBUYXNrV3JpdGVJbnB1dCAmIHsgbmFtZTogc3RyaW5nIH0pOiBzdHJpbmcge1xuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICB0YXNrQ3JlYXRlKGlucHV0OiB7ICR7dGFza0lucHV0UGFydHMoaW5wdXQpfSB9KSB7ICR7VEFTS19OT0RFX0ZJRUxEU30gfVxuICB9YDtcbn1cblxuLyoqIE1FUkdFIHNlbWFudGljczogb25seSB0aGUgcHJvdmlkZWQgZmllbGRzIGNoYW5nZSAobGl2ZS12ZXJpZmllZCkuICovXG5leHBvcnQgZnVuY3Rpb24gdGFza1VwZGF0ZU11dGF0aW9uKHRhc2tJZDogc3RyaW5nLCBpbnB1dDogVGFza1dyaXRlSW5wdXQpOiBzdHJpbmcge1xuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICB0YXNrVXBkYXRlKGlkOiAke2xpdCh0YXNrSWQpfSwgaW5wdXQ6IHsgJHt0YXNrSW5wdXRQYXJ0cyhpbnB1dCl9IH0pIHsgJHtUQVNLX05PREVfRklFTERTfSB9XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdGFza0RlbGV0ZU11dGF0aW9uKHRhc2tJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBtdXRhdGlvbiB7XG4gICAgdGFza0RlbGV0ZShpZDogJHtsaXQodGFza0lkKX0pIHsgaWQgfVxuICB9YDtcbn1cblxuLyoqIEFjY291bnQgdXNlcnMsIGZvciBtYXBwaW5nIGFzc2lnbmVlIGVtYWlscyBcdTIxOTIgUHJpbnRhdm8gdXNlciBJRHMuICovXG5leHBvcnQgZnVuY3Rpb24gYWNjb3VudFVzZXJzUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgYWNjb3VudCB7XG4gICAgICB1c2VycyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhZnRlcil9KSB7XG4gICAgICAgIG5vZGVzIHsgaWQgbmFtZSBlbWFpbCB9XG4gICAgICAgICR7UEFHRV9JTkZPfVxuICAgICAgfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qXG4gKiBcdTI1MDBcdTI1MDAgT3JkZXIgZXh0cmFzIChiYWNrdXAgbW9kdWxlLCBmdWxsLWZpZGVsaXR5IGNhcHR1cmUpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogUGVyLW9yZGVyIHN1cHBsZW1lbnRhbCBxdWVyeSBmb3IgZXZlcnl0aGluZyB0aGUgaG90IHN5bmMgcGF0aHMgc2tpcDpcbiAqIGZlZXMsIGV4cGVuc2VzLCBhcHByb3ZhbCByZXF1ZXN0cywgcHJvZHVjdGlvbiBmaWxlcywgY3VzdG9tIGFkZHJlc3NlcyxcbiAqIHRocmVhZCBzdW1tYXJ5LCBwYXltZW50IHJlcXVlc3QsIHBsdXMgbGluZS1pdGVtL2ltcHJpbnQgZW5yaWNobWVudFxuICogKG1vY2t1cHMsIHBlcnNvbmFsaXphdGlvbnMsIHByaWNlIHJlY2VpcHRzLCBwcm9kdWN0IGNhdGFsb2cgcmVmcywgUE9cbiAqIGxpbmtzKS4gU3RvcmVkIGFzIG9uZSByYXcgYmxvYiBpbiBwdl9vcmRlcnMuZXh0cmFzIFx1MjAxNCBubyBob3QgY29sdW1ucy5cbiAqXG4gKiBDb21wbGV4aXR5IGJ1ZGdldDoga2VwdCB3ZWxsIHVuZGVyIHRoZSAyNWsgY2FwIGJ5IG1vZGVzdCBmaXJzdDogbGltaXRzO1xuICogZXZlcnkgY29ubmVjdGlvbiBjYXJyaWVzIHBhZ2VJbmZvIHNvIGNhbGxlcnMgY2FuIGRldGVjdCArIGZvbGxvd1xuICogb3ZlcmZsb3cgd2l0aCB0aGUgdGFyZ2V0ZWQgcGFnZSBxdWVyaWVzIGJlbG93LlxuICovXG5cbi8vIFByb2JlZCBKdWx5IDIwMjY6IDEwLzI1LzEyLzYgPSBjb21wbGV4aXR5IDI5LDk3NiA+IDI1ayBjYXA7IDgvMjAvMTAvNVxuLy8gbGFuZHMgc2FmZWx5IHVuZGVyLiBCaWdnZXIgb3JkZXJzIGp1c3QgdGFrZSBleHRyYSBjdXJzb3IgcGFnZXMuXG5leHBvcnQgY29uc3QgRVhUUkFTX0dST1VQU19GSVJTVCA9IDg7XG5leHBvcnQgY29uc3QgRVhUUkFTX0xJTkVfSVRFTVNfRklSU1QgPSAyMDtcbmV4cG9ydCBjb25zdCBFWFRSQVNfSU1QUklOVFNfRklSU1QgPSAxMDtcbmV4cG9ydCBjb25zdCBFWFRSQVNfTU9DS1VQU19GSVJTVCA9IDU7XG5leHBvcnQgY29uc3QgRVhUUkFTX0NPTk5FQ1RJT05fRklSU1QgPSAyNTtcblxuY29uc3QgTU9DS1VQX0ZJRUxEUyA9IGBcbiAgaWRcbiAgZnVsbEltYWdlVXJsXG4gIHRodW1ibmFpbFVybFxuICBtaW1lVHlwZVxuICBkaXNwbGF5VGh1bWJuYWlsXG4gIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbmA7XG5cbmNvbnN0IEVYVFJBU19MSU5FX0lURU1fRklFTERTID0gYFxuICBpZFxuICBwb3NpdGlvblxuICBtYXJrdXBQZXJjZW50YWdlXG4gIHRheGVkXG4gIHBlcnNvbmFsaXphdGlvbnMgeyBpZCBuYW1lIHBlcnNvbmFsaXphdGlvbiB9XG4gIHByaWNlUmVjZWlwdCB7IGRlZmF1bHRNYXJrdXBQZXJjZW50YWdlIGRlc2NyaXB0aW9uIHByaWNlIHNpZ25hdHVyZSB9XG4gIHByb2R1Y3Qge1xuICAgIGlkXG4gICAgYnJhbmRcbiAgICBjb2xvclxuICAgIGRlc2NyaXB0aW9uXG4gICAgaXRlbU51bWJlclxuICAgIGNhdGFsb2cgeyBpZCBuYW1lIH1cbiAgfVxuICBwb0xpbmVJdGVtIHtcbiAgICBpZFxuICAgIHB1cmNoYXNlT3JkZXIge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbFBvSWRcbiAgICAgIGdvb2RzU3RhdHVzXG4gICAgICBub3RlXG4gICAgICB2ZW5kb3IgeyBpZCBuYW1lIGNvbXBhbnkgZW1haWwgYWNjb3VudE51bWJlciB9XG4gICAgfVxuICB9XG4gIG1vY2t1cHMoZmlyc3Q6ICR7RVhUUkFTX01PQ0tVUFNfRklSU1R9KSB7XG4gICAgbm9kZXMgeyAke01PQ0tVUF9GSUVMRFN9IH1cbiAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgfVxuYDtcblxuY29uc3QgRVhUUkFTX0lNUFJJTlRfRklFTERTID0gYFxuICBpZFxuICBtb2NrdXBzKGZpcnN0OiAke0VYVFJBU19NT0NLVVBTX0ZJUlNUfSkge1xuICAgIG5vZGVzIHsgJHtNT0NLVVBfRklFTERTfSB9XG4gICAgcGFnZUluZm8geyBoYXNOZXh0UGFnZSB9XG4gIH1cbmA7XG5cbmNvbnN0IEVYVFJBU19PUkRFUl9DT05ORUNUSU9OUyA9IGBcbiAgZmVlcyhmaXJzdDogJHtFWFRSQVNfQ09OTkVDVElPTl9GSVJTVH0pIHtcbiAgICBub2RlcyB7XG4gICAgICBpZFxuICAgICAgYW1vdW50XG4gICAgICBkZXNjcmlwdGlvblxuICAgICAgcXVhbnRpdHlcbiAgICAgIHRheGFibGVcbiAgICAgIHVuaXRQcmljZVxuICAgICAgdW5pdFByaWNlQXNQZXJjZW50YWdlXG4gICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgfVxuICAgICR7UEFHRV9JTkZPfVxuICB9XG4gIGV4cGVuc2VzKGZpcnN0OiAke0VYVFJBU19DT05ORUNUSU9OX0ZJUlNUfSkge1xuICAgIG5vZGVzIHtcbiAgICAgIGlkXG4gICAgICBuYW1lXG4gICAgICBhbW91bnRcbiAgICAgIHRyYW5zYWN0aW9uQXRcbiAgICAgIHVzZXJHZW5lcmF0ZWRcbiAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICB9XG4gICAgJHtQQUdFX0lORk99XG4gIH1cbiAgYXBwcm92YWxSZXF1ZXN0cyhmaXJzdDogJHtFWFRSQVNfQ09OTkVDVElPTl9GSVJTVH0pIHtcbiAgICBub2RlcyB7XG4gICAgICBpZFxuICAgICAgbmFtZVxuICAgICAgc3RhdHVzXG4gICAgICByZXF1ZXN0ZXIgeyBpZCBuYW1lIGVtYWlsIH1cbiAgICAgIHJldHJhY3RvciB7IGlkIG5hbWUgZW1haWwgfVxuICAgICAgcmVzcG9uc2UgeyBuYW1lIGVtYWlsIHJlYXNvbiByZXNwb25kZWRBdCB9XG4gICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgfVxuICAgICR7UEFHRV9JTkZPfVxuICB9XG4gIHByb2R1Y3Rpb25GaWxlcyhmaXJzdDogJHtFWFRSQVNfQ09OTkVDVElPTl9GSVJTVH0pIHtcbiAgICBub2RlcyB7XG4gICAgICBpZFxuICAgICAgbmFtZVxuICAgICAgZmlsZVVybFxuICAgICAgbWltZVR5cGVcbiAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICB9XG4gICAgJHtQQUdFX0lORk99XG4gIH1cbiAgY3VzdG9tQWRkcmVzc2VzKGZpcnN0OiAke0VYVFJBU19DT05ORUNUSU9OX0ZJUlNUfSkge1xuICAgIG5vZGVzIHtcbiAgICAgIGlkXG4gICAgICBuYW1lXG4gICAgICBjdXN0b21lck5hbWVcbiAgICAgIGNvbXBhbnlOYW1lXG4gICAgICBhZGRyZXNzMVxuICAgICAgYWRkcmVzczJcbiAgICAgIGNpdHlcbiAgICAgIHN0YXRlXG4gICAgICBzdGF0ZUlzb1xuICAgICAgemlwQ29kZVxuICAgICAgY291bnRyeVxuICAgICAgY291bnRyeUlzb1xuICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgIH1cbiAgICAke1BBR0VfSU5GT31cbiAgfVxuICB0aHJlYWRTdW1tYXJ5IHsgaWQgdW5yZWFkIH1cbiAgcGF5bWVudFJlcXVlc3Qge1xuICAgIGlkXG4gICAgYW1vdW50XG4gICAgZGVzY3JpcHRpb25cbiAgICBuaWNrbmFtZVxuICAgIHN0YXR1c1xuICAgIHJlcXVlc3RlZEF0XG4gICAgdmlzdWFsSWRcbiAgfVxuICBjb250cmFjdG9yUHJvZmlsZSB7IGlkIGNvbXBhbnlOYW1lIGVtYWlsIHBob25lIHdlYnNpdGUgbG9nbyB9XG5gO1xuXG5mdW5jdGlvbiBleHRyYXNHcm91cHNTZWxlY3Rpb24oYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBsaW5lSXRlbUdyb3VwcyhmaXJzdDogJHtFWFRSQVNfR1JPVVBTX0ZJUlNUfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgIG5vZGVzIHtcbiAgICAgIGlkXG4gICAgICBsaW5lSXRlbXMoZmlyc3Q6ICR7RVhUUkFTX0xJTkVfSVRFTVNfRklSU1R9KSB7XG4gICAgICAgIG5vZGVzIHsgJHtFWFRSQVNfTElORV9JVEVNX0ZJRUxEU30gfVxuICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgIH1cbiAgICAgIGltcHJpbnRzKGZpcnN0OiAke0VYVFJBU19JTVBSSU5UU19GSVJTVH0pIHtcbiAgICAgICAgbm9kZXMgeyAke0VYVFJBU19JTVBSSU5UX0ZJRUxEU30gfVxuICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgIH1cbiAgICB9XG4gICAgJHtQQUdFX0lORk99XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJFeHRyYXNRdWVyeShcbiAga2luZDogXCJpbnZvaWNlXCIgfCBcInF1b3RlXCIsXG4gIHByaW50YXZvSWQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgICR7a2luZH0oaWQ6ICR7bGl0KHByaW50YXZvSWQpfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICAke0VYVFJBU19PUkRFUl9DT05ORUNUSU9OU31cbiAgICAgICR7ZXh0cmFzR3JvdXBzU2VsZWN0aW9uKCl9XG4gICAgfVxuICB9YDtcbn1cblxuLyoqIEZvbGxvdy11cCBwYWdlIG9mIGV4dHJhcyBsaW5lSXRlbUdyb3VwcyAob3JkZXJzIHdpdGggPjEwIGdyb3VwcykuICovXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJFeHRyYXNHcm91cHNQYWdlUXVlcnkoXG4gIGtpbmQ6IFwiaW52b2ljZVwiIHwgXCJxdW90ZVwiLFxuICBwcmludGF2b0lkOiBzdHJpbmcsXG4gIGFmdGVyOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICAke2tpbmR9KGlkOiAke2xpdChwcmludGF2b0lkKX0pIHtcbiAgICAgIGlkXG4gICAgICAke2V4dHJhc0dyb3Vwc1NlbGVjdGlvbihhZnRlcil9XG4gICAgfVxuICB9YDtcbn1cblxuLyoqXG4gKiBGb2xsb3ctdXAgcGFnZSBmb3IgYW4gb3ZlcmZsb3dlZCBvcmRlci1sZXZlbCBleHRyYXMgY29ubmVjdGlvblxuICogKGZlZXMgLyBleHBlbnNlcyAvIGFwcHJvdmFsUmVxdWVzdHMgLyBwcm9kdWN0aW9uRmlsZXMgLyBjdXN0b21BZGRyZXNzZXNcbiAqIGJleW9uZCB0aGUgZmlyc3QgMjUgXHUyMDE0IHJhcmUsIGJ1dCBwYWdlZCBmb3IgY29ycmVjdG5lc3MpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJFeHRyYXNDb25uZWN0aW9uUGFnZVF1ZXJ5KFxuICBraW5kOiBcImludm9pY2VcIiB8IFwicXVvdGVcIixcbiAgcHJpbnRhdm9JZDogc3RyaW5nLFxuICBjb25uZWN0aW9uOlxuICAgIHwgXCJmZWVzXCJcbiAgICB8IFwiZXhwZW5zZXNcIlxuICAgIHwgXCJhcHByb3ZhbFJlcXVlc3RzXCJcbiAgICB8IFwicHJvZHVjdGlvbkZpbGVzXCJcbiAgICB8IFwiY3VzdG9tQWRkcmVzc2VzXCIsXG4gIGFmdGVyOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBzZWxlY3Rpb25zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIGZlZXM6IGBpZCBhbW91bnQgZGVzY3JpcHRpb24gcXVhbnRpdHkgdGF4YWJsZSB1bml0UHJpY2UgdW5pdFByaWNlQXNQZXJjZW50YWdlIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICAgIGV4cGVuc2VzOiBgaWQgbmFtZSBhbW91bnQgdHJhbnNhY3Rpb25BdCB1c2VyR2VuZXJhdGVkIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICAgIGFwcHJvdmFsUmVxdWVzdHM6IGBpZCBuYW1lIHN0YXR1cyByZXF1ZXN0ZXIgeyBpZCBuYW1lIGVtYWlsIH0gcmV0cmFjdG9yIHsgaWQgbmFtZSBlbWFpbCB9IHJlc3BvbnNlIHsgbmFtZSBlbWFpbCByZWFzb24gcmVzcG9uZGVkQXQgfSB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgICBwcm9kdWN0aW9uRmlsZXM6IGBpZCBuYW1lIGZpbGVVcmwgbWltZVR5cGUgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gICAgY3VzdG9tQWRkcmVzc2VzOiBgaWQgbmFtZSBjdXN0b21lck5hbWUgY29tcGFueU5hbWUgYWRkcmVzczEgYWRkcmVzczIgY2l0eSBzdGF0ZSBzdGF0ZUlzbyB6aXBDb2RlIGNvdW50cnkgY291bnRyeUlzbyB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgfTtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgJHtraW5kfShpZDogJHtsaXQocHJpbnRhdm9JZCl9KSB7XG4gICAgICBpZFxuICAgICAgJHtjb25uZWN0aW9ufShmaXJzdDogJHtFWFRSQVNfQ09OTkVDVElPTl9GSVJTVH0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgICAgbm9kZXMgeyAke3NlbGVjdGlvbnNbY29ubmVjdGlvbl19IH1cbiAgICAgICAgJHtQQUdFX0lORk99XG4gICAgICB9XG4gICAgfVxuICB9YDtcbn1cblxuLypcbiAqIFx1MjUwMFx1MjUwMCBCNCBiYWNrdXAgZW50aXRpZXMgKHRocmVhZHMvbWVzc2FnZXMsIG1lcmNoLCBpbnF1aXJpZXMsIHBheW1lbnRcbiAqICAgIHJlcXVlc3RzLCBhY2NvdW50IHJlZmVyZW5jZSBkYXRhKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIEFsbCByYXctYmxvYiBjYXB0dXJlcy4gSW50cm9zcGVjdGVkIGxpdmUgSnVseSAyMDI2OlxuICogLSB0aHJlYWRzIFx1MjE5MiBUaHJlYWRTdW1tYXJ5Q29ubmVjdGlvbiBPTkxZIChpZCwgdW5yZWFkLCByZWdhcmRpbmcsXG4gKiAgIGxhc3RSZWNlaXZlZE1lc3NhZ2UpOyBmdWxsIG1lc3NhZ2VzIHJlcXVpcmUgdGhyZWFkKGlkKXttZXNzYWdlc30uXG4gKiAgIFRoZSBsaXN0IGlzIG9yZGVyZWQgYnkgbGFzdFJlY2VpdmVkTWVzc2FnZSByZWNlbmN5ICh2ZXJpZmllZCBhY3Jvc3NcbiAqICAgcGFnZXMpLCBhbmQgbGFzdFJlY2VpdmVkTWVzc2FnZSB0cmFja3MgSU5DT01JTkcgbWVzc2FnZXMgb25seS5cbiAqIC0gbWVyY2ggb3JkZXJzIGhhdmUgTk8gcm9vdCBsaXN0IFx1MjAxNCBvbmx5IG1lcmNoU3RvcmUoaWQpLm9yZGVycy5cbiAqIC0gUHJpY2luZ01hdHJpeENlbGwgZXhwb3NlcyBOTyBwcmljZS9xdWFudGl0eSB2YWx1ZXMgKHN0cnVjdHVyYWwgaWRzXG4gKiAgIG9ubHkpLCBzbyBtYXRyaWNlcyBhcmUgY2FwdHVyZWQgd2l0aCBjb2x1bW5zIGJ1dCB3aXRob3V0IGNlbGxzLlxuICovXG5cbmNvbnN0IFRIUkVBRF9SRUdBUkRJTkcgPSBgXG4gIHJlZ2FyZGluZyB7XG4gICAgX190eXBlbmFtZVxuICAgIC4uLiBvbiBJbnZvaWNlIHsgaWQgdmlzdWFsSWQgfVxuICAgIC4uLiBvbiBRdW90ZSB7IGlkIHZpc3VhbElkIH1cbiAgfVxuYDtcblxuZXhwb3J0IGZ1bmN0aW9uIHRocmVhZHNQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgdGhyZWFkcyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhZnRlcil9KSB7XG4gICAgICBub2RlcyB7XG4gICAgICAgIGlkXG4gICAgICAgIHVucmVhZFxuICAgICAgICAke1RIUkVBRF9SRUdBUkRJTkd9XG4gICAgICAgIGxhc3RSZWNlaXZlZE1lc3NhZ2Uge1xuICAgICAgICAgIF9fdHlwZW5hbWVcbiAgICAgICAgICAuLi4gb24gRW1haWxNZXNzYWdlIHsgaWQgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB9IH1cbiAgICAgICAgICAuLi4gb24gVGV4dE1lc3NhZ2UgeyBpZCB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IH0gfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG5jb25zdCBNRVNTQUdFX1BBUlRJQ0lQQU5UID0gYFxuICBfX3R5cGVuYW1lXG4gIC4uLiBvbiBDb250YWN0IHsgaWQgZnVsbE5hbWUgZW1haWwgfVxuICAuLi4gb24gVXNlciB7IGlkIG5hbWUgZW1haWwgfVxuYDtcblxuY29uc3QgTUVTU0FHRV9DT01NT05fRklFTERTID0gYFxuICBpZFxuICBmcm9tXG4gIHRvXG4gIGluY29taW5nXG4gIHN0YXR1c1xuICB0ZXh0XG4gIHNlbmRlciB7ICR7TUVTU0FHRV9QQVJUSUNJUEFOVH0gfVxuICByZWNpcGllbnQgeyAke01FU1NBR0VfUEFSVElDSVBBTlR9IH1cbiAgYXR0YWNobWVudHMoZmlyc3Q6IDI1KSB7XG4gICAgbm9kZXMgeyBmaWxlbmFtZSB1cmwgfVxuICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICB9XG4gIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbmA7XG5cbi8qKiBPbmUgcGFnZSBvZiBhIHRocmVhZCdzIGZ1bGwgbWVzc2FnZXMgKDI1L3BhZ2UsIHBhZ2VkIHRvIGV4aGF1c3Rpb24pLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRocmVhZE1lc3NhZ2VzUGFnZVF1ZXJ5KFxuICB0aHJlYWRJZDogc3RyaW5nLFxuICBhZnRlcj86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICB0aHJlYWQoaWQ6ICR7bGl0KHRocmVhZElkKX0pIHtcbiAgICAgIGlkXG4gICAgICB1bnJlYWRcbiAgICAgIG1lc3NhZ2VzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgICAgbm9kZXMge1xuICAgICAgICAgIF9fdHlwZW5hbWVcbiAgICAgICAgICAuLi4gb24gRW1haWxNZXNzYWdlIHsgJHtNRVNTQUdFX0NPTU1PTl9GSUVMRFN9IHN1YmplY3QgY2MgYmNjIH1cbiAgICAgICAgICAuLi4gb24gVGV4dE1lc3NhZ2UgeyAke01FU1NBR0VfQ09NTU9OX0ZJRUxEU30gfVxuICAgICAgICB9XG4gICAgICAgICR7UEFHRV9JTkZPfVxuICAgICAgfVxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnF1aXJpZXNQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgaW5xdWlyaWVzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgIG5vZGVzIHtcbiAgICAgICAgaWRcbiAgICAgICAgbmFtZVxuICAgICAgICBlbWFpbFxuICAgICAgICBwaG9uZVxuICAgICAgICByZXF1ZXN0XG4gICAgICAgIHVucmVhZFxuICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG4vKipcbiAqIFBheW1lbnQgcmVxdWVzdHMsIG5ld2VzdC1maXJzdC4gTGlzdCBwYWdlIHNpemUgMTAgKG5vdCAyNSkgXHUyMDE0IHRoZSB0d29cbiAqIG5lc3RlZCBmaXJzdDoyNSBjb25uZWN0aW9ucyB3b3VsZCBvdGhlcndpc2UgcmlzayB0aGUgMjVrIGNvbXBsZXhpdHlcbiAqIGNhcCAocHJvYmVkIE9LIGxpdmUgYXQgMTAvMjUvMjUsIEp1bHkgMjAyNikuXG4gKi9cbmV4cG9ydCBjb25zdCBQQVlNRU5UX1JFUVVFU1RTX1BBR0VfU0laRSA9IDEwO1xuXG5leHBvcnQgZnVuY3Rpb24gcGF5bWVudFJlcXVlc3RzUGFnZVF1ZXJ5KFxuICBhZnRlcj86IHN0cmluZyB8IG51bGwsXG4gIG9wdGlvbnM/OiB7IG9taXRSZXF1ZXN0ZWRCeT86IGJvb2xlYW4gfSxcbik6IHN0cmluZyB7XG4gIC8vIFByaW50YXZvIGRlY2xhcmVzIFBheW1lbnRSZXF1ZXN0LnJlcXVlc3RlZEJ5IG5vbi1udWxsYWJsZSwgYnV0IGl0XG4gIC8vIENBTiBiZSBudWxsIGluIHByYWN0aWNlIChyZXF1ZXN0aW5nIHVzZXIgZGVsZXRlZCkgXHUyMDE0IGFuZCB0aGUgd2hvbGVcbiAgLy8gcmVzcG9uc2UgZGF0YSBudWxscyBvdXQgKHZlcmlmaWVkIGxpdmU6IG5vIHBhcnRpYWwgZGF0YSBzdXJ2aXZlcykuXG4gIC8vIENhbGxlcnMgcmV0cnkgdGhlIHBvaXNvbmVkIHBhZ2Ugd2l0aG91dCB0aGUgZmllbGQuXG4gIGNvbnN0IHJlcXVlc3RlZEJ5RmllbGQgPSBvcHRpb25zPy5vbWl0UmVxdWVzdGVkQnlcbiAgICA/IFwiXCJcbiAgICA6IFwiXFxuICAgICAgICByZXF1ZXN0ZWRCeSB7IGlkIG5hbWUgZW1haWwgfVwiO1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBwYXltZW50UmVxdWVzdHMoZmlyc3Q6ICR7UEFZTUVOVF9SRVFVRVNUU19QQUdFX1NJWkV9JHthZnRlckFyZyhhZnRlcil9LCBzb3J0RGVzY2VuZGluZzogdHJ1ZSkge1xuICAgICAgbm9kZXMge1xuICAgICAgICBpZFxuICAgICAgICB2aXN1YWxJZFxuICAgICAgICBhbW91bnRcbiAgICAgICAgZGVzY3JpcHRpb25cbiAgICAgICAgbmlja25hbWVcbiAgICAgICAgc3RhdHVzXG4gICAgICAgIHJlcXVlc3RlZEF0JHtyZXF1ZXN0ZWRCeUZpZWxkfVxuICAgICAgICBjb250YWN0IHsgaWQgY29tcGFueU5hbWUgfVxuICAgICAgICByZXF1ZXN0ZWREZXRhaWxzKGZpcnN0OiAyNSkge1xuICAgICAgICAgIG5vZGVzIHtcbiAgICAgICAgICAgIGlkXG4gICAgICAgICAgICBvcmRlclZpc3VhbElkXG4gICAgICAgICAgICByZXF1ZXN0ZWRBbW91bnRcbiAgICAgICAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICAgICAgICB9XG4gICAgICAgICAgcGFnZUluZm8geyBoYXNOZXh0UGFnZSB9XG4gICAgICAgIH1cbiAgICAgICAgcGF5bWVudHMoZmlyc3Q6IDI1KSB7XG4gICAgICAgICAgbm9kZXMge1xuICAgICAgICAgICAgaWRcbiAgICAgICAgICAgIGFtb3VudFxuICAgICAgICAgICAgY2F0ZWdvcnlcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uXG4gICAgICAgICAgICBwcm9jZXNzaW5nXG4gICAgICAgICAgICBzb3VyY2VcbiAgICAgICAgICAgIHRyYW5zYWN0aW9uRGF0ZVxuICAgICAgICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgICAgfVxuICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWVyY2hTdG9yZXNQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgbWVyY2hTdG9yZXMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgbm9kZXMge1xuICAgICAgICBpZFxuICAgICAgICBuYW1lXG4gICAgICAgIHN0YXR1c1xuICAgICAgICBjbG9zZXNBdFxuICAgICAgICBzdW1tYXJ5IHsgaXRlbXNTb2xkIHRvdGFsU2FsZXMgdG90YWxUYXggfVxuICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG5jb25zdCBNRVJDSF9BRERSRVNTX0ZJRUxEUyA9IGBcbiAgaWRcbiAgbmFtZVxuICBwaG9uZVxuICByZXNpZGVudGlhbFxuICBhZGRyZXNzMVxuICBhZGRyZXNzMlxuICBjaXR5XG4gIHN0YXRlXG4gIHN0YXRlSXNvXG4gIHppcENvZGVcbiAgY291bnRyeVxuICBjb3VudHJ5SXNvXG5gO1xuXG4vKiogT25lIHBhZ2Ugb2YgYSBtZXJjaCBzdG9yZSdzIG9yZGVycyAob25seSByZWFjaGFibGUgcGVyLXN0b3JlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJjaFN0b3JlT3JkZXJzUGFnZVF1ZXJ5KFxuICBzdG9yZUlkOiBzdHJpbmcsXG4gIGFmdGVyPzogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIG1lcmNoU3RvcmUoaWQ6ICR7bGl0KHN0b3JlSWQpfSkge1xuICAgICAgaWRcbiAgICAgIG9yZGVycyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhZnRlcil9KSB7XG4gICAgICAgIG5vZGVzIHtcbiAgICAgICAgICBpZFxuICAgICAgICAgIHZpc3VhbElkXG4gICAgICAgICAgc3RhdHVzXG4gICAgICAgICAgcXVhbnRpdHlcbiAgICAgICAgICBpdGVtVG90YWxcbiAgICAgICAgICBwcm9tb1RvdGFsXG4gICAgICAgICAgdGF4XG4gICAgICAgICAgdG90YWxcbiAgICAgICAgICBjb21wbGV0ZWRBdFxuICAgICAgICAgIGRlbGl2ZXJ5IHsgZmxhdFJhdGUgbWV0aG9kIHRvdGFsIHRvdGFsQWN0dWFsIH1cbiAgICAgICAgICBiaWxsaW5nQWRkcmVzcyB7ICR7TUVSQ0hfQUREUkVTU19GSUVMRFN9IH1cbiAgICAgICAgICBzaGlwcGluZ0FkZHJlc3MgeyAke01FUkNIX0FERFJFU1NfRklFTERTfSB9XG4gICAgICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgICAgICB9XG4gICAgICAgICR7UEFHRV9JTkZPfVxuICAgICAgfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qKlxuICogQWNjb3VudC1sZXZlbCByZWZlcmVuY2UgY29ubmVjdGlvbnMsIG9uZSBxdWVyeSBwZXIga2luZC4gS2luZCBrZXlzXG4gKiBkb3VibGUgYXMgcHZfcmVmZXJlbmNlX2Jsb2JzLmtpbmQgdmFsdWVzLlxuICovXG5leHBvcnQgY29uc3QgUkVGRVJFTkNFX0tJTkRTID0gW1xuICBcImRlbGl2ZXJ5X21ldGhvZFwiLFxuICBcInBheW1lbnRfdGVybVwiLFxuICBcInVzZXJcIixcbiAgXCJwcmljaW5nX21hdHJpeFwiLFxuICBcImVtYWlsX3RlbXBsYXRlXCIsXG4gIFwidHlwZV9vZl93b3JrXCIsXG4gIFwiY2F0ZWdvcnlcIixcbiAgXCJwcmVzZXRfdGFza19ncm91cFwiLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgUmVmZXJlbmNlS2luZCA9ICh0eXBlb2YgUkVGRVJFTkNFX0tJTkRTKVtudW1iZXJdO1xuXG5jb25zdCBSRUZFUkVOQ0VfU0VMRUNUSU9OUzogUmVjb3JkPFJlZmVyZW5jZUtpbmQsIHsgZmllbGQ6IHN0cmluZzsgc2VsZWN0aW9uOiBzdHJpbmcgfT4gPSB7XG4gIGRlbGl2ZXJ5X21ldGhvZDoge1xuICAgIGZpZWxkOiBcImRlbGl2ZXJ5TWV0aG9kc1wiLFxuICAgIHNlbGVjdGlvbjogYGlkIG5hbWUgYXJjaGl2ZWQgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gIH0sXG4gIHBheW1lbnRfdGVybToge1xuICAgIGZpZWxkOiBcInBheW1lbnRUZXJtc1wiLFxuICAgIHNlbGVjdGlvbjogYGlkIG5hbWUgZGF5cyBhcmNoaXZlZCBpblVzZSB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgfSxcbiAgdXNlcjoge1xuICAgIGZpZWxkOiBcInVzZXJzXCIsXG4gICAgc2VsZWN0aW9uOiBgaWQgbmFtZSBlbWFpbCBwaG9uZSB0aW1lWm9uZSB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgfSxcbiAgcHJpY2luZ19tYXRyaXg6IHtcbiAgICBmaWVsZDogXCJwcmljaW5nTWF0cmljZXNcIixcbiAgICBzZWxlY3Rpb246IGBpZCBuYW1lIHR5cGVPZldvcmsgeyBpZCBuYW1lIGFyY2hpdmVkIH0gY29sdW1ucyB7IGlkIGNvbHVtbk5hbWUgfSB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgfSxcbiAgZW1haWxfdGVtcGxhdGU6IHtcbiAgICBmaWVsZDogXCJlbWFpbFRlbXBsYXRlc1wiLFxuICAgIHNlbGVjdGlvbjogYGlkIG5hbWUgc3ViamVjdCBib2R5IHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICB9LFxuICB0eXBlX29mX3dvcms6IHtcbiAgICBmaWVsZDogXCJ0eXBlc09mV29ya1wiLFxuICAgIHNlbGVjdGlvbjogYGlkIG5hbWUgYXJjaGl2ZWQgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gIH0sXG4gIGNhdGVnb3J5OiB7XG4gICAgZmllbGQ6IFwiY2F0ZWdvcmllc1wiLFxuICAgIHNlbGVjdGlvbjogYGlkIG5hbWUgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gIH0sXG4gIHByZXNldF90YXNrX2dyb3VwOiB7XG4gICAgZmllbGQ6IFwicHJlc2V0VGFza0dyb3Vwc1wiLFxuICAgIHNlbGVjdGlvbjogYGlkIHRpdGxlIHByZXNldFRhc2tzKGZpcnN0OiAyNSkgeyBub2RlcyB7IGlkIG5hbWUgcG9zaXRpb24gYXNzaWduZWRUbyB7IGlkIG5hbWUgZW1haWwgfSB9IHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfSB9IHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICB9LFxufTtcblxuLyoqIFRoZSBhY2NvdW50IGNvbm5lY3Rpb24gZmllbGQgbmFtZSBmb3IgYSByZWZlcmVuY2Uga2luZCAoZm9yIHJlc3BvbnNlIHBhcnNpbmcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZmVyZW5jZUZpZWxkRm9yKGtpbmQ6IFJlZmVyZW5jZUtpbmQpOiBzdHJpbmcge1xuICByZXR1cm4gUkVGRVJFTkNFX1NFTEVDVElPTlNba2luZF0uZmllbGQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhY2NvdW50UmVmZXJlbmNlUGFnZVF1ZXJ5KFxuICBraW5kOiBSZWZlcmVuY2VLaW5kLFxuICBhZnRlcj86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCB7IGZpZWxkLCBzZWxlY3Rpb24gfSA9IFJFRkVSRU5DRV9TRUxFQ1RJT05TW2tpbmRdO1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBhY2NvdW50IHtcbiAgICAgICR7ZmllbGR9KGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgICAgbm9kZXMgeyAke3NlbGVjdGlvbn0gfVxuICAgICAgICAke1BBR0VfSU5GT31cbiAgICAgIH1cbiAgICB9XG4gIH1gO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgSHViIFByaWNlIENhbGN1bGF0b3IgbXV0YXRpb25zIChhZGRlZCBmb3IgVGFzayAjMjcpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEZldGNoIGEgc2luZ2xlIGludm9pY2UgYnkgaXRzIGludGVybmFsIFByaW50YXZvIGlkLCByZXR1cm5pbmcgb25seSB0aGVcbiAqIGZpZWxkcyBuZWVkZWQgYnkgdGhlIEh1YiBQcmljZSBDYWxjdWxhdG9yIHB1c2ggKHByb2R1Y3Rpb25Ob3RlICsgaWQvdmlzdWFsSWQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW52b2ljZUJ5SWRRdWVyeShwcmludGF2b0lkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBpbnZvaWNlKGlkOiAke2xpdChwcmludGF2b0lkKX0pIHtcbiAgICAgIGlkXG4gICAgICB2aXN1YWxJZFxuICAgICAgcHJvZHVjdGlvbk5vdGVcbiAgICB9XG4gIH1gO1xufVxuXG4vKipcbiAqIEZldGNoIGEgc2luZ2xlIHF1b3RlIGJ5IGl0cyBpbnRlcm5hbCBQcmludGF2byBpZCwgcmV0dXJuaW5nIG9ubHkgdGhlXG4gKiBmaWVsZHMgbmVlZGVkIGJ5IHRoZSBIdWIgUHJpY2UgQ2FsY3VsYXRvciBwdXNoIChwcm9kdWN0aW9uTm90ZSArIGlkL3Zpc3VhbElkKS5cbiAqXG4gKiBOT1RFOiBRdW90ZS52aXN1YWxJZCBpcyBhIFN0cmluZyBpbiB0aGUgUHJpbnRhdm8gc2NoZW1hIChJbnZvaWNlLnZpc3VhbElkXG4gKiBpcyBhbiBJbnQpIFx1MjAxNCBjYWxsZXJzIG11c3Qgbm9ybWFsaXplIHdpdGggTnVtYmVyKCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBxdW90ZUJ5SWRRdWVyeShwcmludGF2b0lkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBxdW90ZShpZDogJHtsaXQocHJpbnRhdm9JZCl9KSB7XG4gICAgICBpZFxuICAgICAgdmlzdWFsSWRcbiAgICAgIHByb2R1Y3Rpb25Ob3RlXG4gICAgfVxuICB9YDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJbnZvaWNlVXBkYXRlSW5wdXQge1xuICBwcm9kdWN0aW9uTm90ZT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBVcGRhdGUgYW4gaW52b2ljZSdzIG11dGFibGUgaGVhZGVyIGZpZWxkcyAoSHViIFByaWNlIENhbGN1bGF0b3IgcHVzaCkuXG4gKiBPbmx5IG5vbi11bmRlZmluZWQgZmllbGRzIGFyZSBlbWl0dGVkLlxuICogVXNlcyBgaW52b2ljZVVwZGF0ZShpZCwgaW5wdXQpYCBcdTIwMTQgdmVyaWZpZWQgdmlhIFByaW50YXZvIHNjaGVtYS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludm9pY2VVcGRhdGVNdXRhdGlvbihcbiAgaW52b2ljZUlkOiBzdHJpbmcsXG4gIGlucHV0OiBJbnZvaWNlVXBkYXRlSW5wdXQsXG4pOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGlucHV0LnByb2R1Y3Rpb25Ob3RlICE9PSB1bmRlZmluZWQpIHtcbiAgICBwYXJ0cy5wdXNoKGBwcm9kdWN0aW9uTm90ZTogJHtsaXQoaW5wdXQucHJvZHVjdGlvbk5vdGUpfWApO1xuICB9XG4gIGlmIChwYXJ0cy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbnZvaWNlVXBkYXRlTXV0YXRpb246IGF0IGxlYXN0IG9uZSBmaWVsZCBtdXN0IGJlIHByb3ZpZGVkXCIpO1xuICB9XG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIGludm9pY2VVcGRhdGUoaWQ6ICR7bGl0KGludm9pY2VJZCl9LCBpbnB1dDogeyAke3BhcnRzLmpvaW4oXCIsIFwiKX0gfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICBwcm9kdWN0aW9uTm90ZVxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUXVvdGVVcGRhdGVJbnB1dCB7XG4gIHByb2R1Y3Rpb25Ob3RlPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFVwZGF0ZSBhIHF1b3RlJ3MgbXV0YWJsZSBoZWFkZXIgZmllbGRzIChIdWIgUHJpY2UgQ2FsY3VsYXRvciBwdXNoKS5cbiAqIE9ubHkgbm9uLXVuZGVmaW5lZCBmaWVsZHMgYXJlIGVtaXR0ZWQuXG4gKiBVc2VzIGBxdW90ZVVwZGF0ZShpZCwgaW5wdXQpYCB3aXRoIFByaW50YXZvJ3MgUXVvdGVJbnB1dCB0eXBlIFx1MjAxNCB2ZXJpZmllZFxuICogdmlhIHNjaGVtYSBpbnRyb3NwZWN0aW9uIHRoYXQgUXVvdGVJbnB1dCBpbmNsdWRlcyBwcm9kdWN0aW9uTm90ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHF1b3RlVXBkYXRlTXV0YXRpb24oXG4gIHF1b3RlSWQ6IHN0cmluZyxcbiAgaW5wdXQ6IFF1b3RlVXBkYXRlSW5wdXQsXG4pOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGlucHV0LnByb2R1Y3Rpb25Ob3RlICE9PSB1bmRlZmluZWQpIHtcbiAgICBwYXJ0cy5wdXNoKGBwcm9kdWN0aW9uTm90ZTogJHtsaXQoaW5wdXQucHJvZHVjdGlvbk5vdGUpfWApO1xuICB9XG4gIGlmIChwYXJ0cy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJxdW90ZVVwZGF0ZU11dGF0aW9uOiBhdCBsZWFzdCBvbmUgZmllbGQgbXVzdCBiZSBwcm92aWRlZFwiKTtcbiAgfVxuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICBxdW90ZVVwZGF0ZShpZDogJHtsaXQocXVvdGVJZCl9LCBpbnB1dDogeyAke3BhcnRzLmpvaW4oXCIsIFwiKX0gfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICBwcm9kdWN0aW9uTm90ZVxuICAgIH1cbiAgfWA7XG59XG4iLCAiaW1wb3J0IHsgUHJpbnRhdm9DbGllbnQsIHR5cGUgUHJpbnRhdm9DbGllbnRTdGF0cyB9IGZyb20gXCJAd29ya3NwYWNlL3ByaW50YXZvXCI7XG5cbmxldCBjbGllbnQ6IFByaW50YXZvQ2xpZW50IHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBwcmludGF2b0NvbmZpZ3VyZWQoKTogYm9vbGVhbiB7XG4gIHJldHVybiBCb29sZWFuKFxuICAgIHByb2Nlc3MuZW52W1wiUFJJTlRBVk9fQVBJX0VNQUlMXCJdICYmIHByb2Nlc3MuZW52W1wiUFJJTlRBVk9fQVBJX1RPS0VOXCJdLFxuICApO1xufVxuXG4vKipcbiAqIFRoZSBzaW5nbGUgc2hhcmVkIGdhdGV3YXkuIEV2ZXJ5IFByaW50YXZvIGNhbGwgaW4gdGhlIGVudGlyZSBIdWIgbXVzdCBnb1xuICogdGhyb3VnaCB0aGlzIGNsaWVudCBzbyB0aGUgaW4tcHJvY2VzcyB0aHJvdHRsZSBhY3R1YWxseSBwcm90ZWN0cyB0aGVcbiAqIGFjY291bnQtd2lkZSAxMCByZXEvNXMgbGltaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRQcmludGF2b0NsaWVudCgpOiBQcmludGF2b0NsaWVudCB7XG4gIGlmICghY2xpZW50KSB7XG4gICAgY29uc3QgZW1haWwgPSBwcm9jZXNzLmVudltcIlBSSU5UQVZPX0FQSV9FTUFJTFwiXTtcbiAgICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52W1wiUFJJTlRBVk9fQVBJX1RPS0VOXCJdO1xuICAgIGlmICghZW1haWwgfHwgIXRva2VuKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiUFJJTlRBVk9fQVBJX0VNQUlMIGFuZCBQUklOVEFWT19BUElfVE9LRU4gbXVzdCBiZSBzZXQgdG8gdGFsayB0byBQcmludGF2b1wiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY2xpZW50ID0gbmV3IFByaW50YXZvQ2xpZW50KHsgZW1haWwsIHRva2VuIH0pO1xuICB9XG4gIHJldHVybiBjbGllbnQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwcmludGF2b0NsaWVudFN0YXRzKCk6IFByaW50YXZvQ2xpZW50U3RhdHMgfCBudWxsIHtcbiAgcmV0dXJuIGNsaWVudCA/IGNsaWVudC5zdGF0cyA6IG51bGw7XG59XG4iLCAiaW1wb3J0IHtcbiAgaW52b2ljZXNQYWdlUXVlcnksXG4gIHF1b3Rlc1BhZ2VRdWVyeSxcbiAgc2luZ2xlT3JkZXJTdGF0dXNRdWVyeSxcbiAgdHlwZSBDb25uZWN0aW9uLFxuICB0eXBlIEludm9pY2VzUGFnZSxcbiAgdHlwZSBPcmRlcktpbmQsXG4gIHR5cGUgUHZPcmRlck5vZGUsXG4gIHR5cGUgUXVvdGVzUGFnZSxcbiAgdHlwZSBTaW5nbGVPcmRlclN0YXR1cyxcbn0gZnJvbSBcIkB3b3Jrc3BhY2UvcHJpbnRhdm9cIjtcbmltcG9ydCB7IGdldFByaW50YXZvQ2xpZW50IH0gZnJvbSBcIi4uLy4uL3ByaW50YXZvR2F0ZXdheVwiO1xuXG4vKipcbiAqIEEgZGVsaWJlcmF0ZWx5IHNtYWxsIGNsaWVudCBzdXJmYWNlIGtlZXBzIGxpdmUgZGlzY292ZXJ5IHVuaXQtdGVzdGFibGUgd2hpbGVcbiAqIHN0aWxsIHJlcXVpcmluZyB0aGUgcHJvZHVjdGlvbiBjYWxsZXIgdG8gdXNlIHRoZSBzaGFyZWQgUHJpbnRhdm8gZ2F0ZXdheS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBMaXZlT3JkZXJRdWVyeUNsaWVudCB7XG4gIHF1ZXJ5PFQ+KFxuICAgIHF1ZXJ5OiBzdHJpbmcsXG4gICAgdmFyaWFibGVzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICk6IFByb21pc2U8VD47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGl2ZUF1dG9QcmludE9yZGVyIHtcbiAga2luZDogT3JkZXJLaW5kO1xuICBub2RlOiBQdk9yZGVyTm9kZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBMaXZlRGlzY292ZXJ5UmVzdWx0IHtcbiAgb3JkZXJzOiBMaXZlQXV0b1ByaW50T3JkZXJbXTtcbiAgcGFnZXM6IFJlY29yZDxcImludm9pY2VzXCIgfCBcInF1b3Rlc1wiLCBudW1iZXI+O1xufVxuXG5leHBvcnQgdHlwZSBMaXZlRGlzY292ZXJ5RXJyb3JLaW5kID1cbiAgfCBcInJlcXVlc3RcIlxuICB8IFwidW5zdXBwb3J0ZWRfZmlsdGVyXCJcbiAgfCBcImluY29tcGxldGVfcGFnaW5hdGlvblwiXG4gIHwgXCJpbnZhbGlkX3Jlc3BvbnNlXCI7XG5cbi8qKlxuICogRGlzY292ZXJ5IGVycm9ycyBhcmUgaW50ZW50aW9uYWxseSBkaXN0aW5jdCBmcm9tIHBlci1vcmRlciBwcmludCBlcnJvcnMuXG4gKiBUaGUgZW5naW5lIG11c3QgZmFpbCB0aGUgcnVuIGJlZm9yZSByZW5kZXJpbmcgb3Igc3VibWl0dGluZyBhbnl0aGluZyB3aGVuXG4gKiBsaXZlIGRpc2NvdmVyeSBpcyBub3QgY29tcGxldGUuXG4gKi9cbmV4cG9ydCBjbGFzcyBMaXZlRGlzY292ZXJ5RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICBwdWJsaWMgcmVhZG9ubHkga2luZDogTGl2ZURpc2NvdmVyeUVycm9yS2luZCxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJMaXZlRGlzY292ZXJ5RXJyb3JcIjtcbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIExpdmVPcmRlclN0YXR1cyB7XG4gIG9yZGVySWQ6IHN0cmluZztcbiAgdmlzdWFsSWQ6IG51bWJlciB8IG51bGw7XG4gIHN0YXR1c0lkOiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXNOYW1lOiBzdHJpbmcgfCBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVWaXN1YWxJZChyYXc6IHVua25vd24pOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgdmlzdWFsSWQgPVxuICAgIHR5cGVvZiByYXcgPT09IFwibnVtYmVyXCJcbiAgICAgID8gcmF3XG4gICAgICA6IHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgJiYgL15cXGQrJC8udGVzdChyYXcudHJpbSgpKVxuICAgICAgICA/IE51bWJlcihyYXcpXG4gICAgICAgIDogTnVtYmVyLk5hTjtcbiAgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKHZpc3VhbElkKSA/IHZpc3VhbElkIDogbnVsbDtcbn1cblxuLyoqXG4gKiBSZWFkIG9uZSBleGFjdCBvcmRlcidzIGN1cnJlbnQgc3RhdHVzIHRocm91Z2ggdGhlIHNoYXJlZCBnYXRld2F5LiBUaGlzIGlzXG4gKiBpbnRlbnRpb25hbGx5IHNlcGFyYXRlIGZyb20gZGV0YWlsIHJlZnJlc2g6IGRldGFpbCBxdWVyaWVzIGRvIG5vdCBpbmNsdWRlXG4gKiBzdGF0dXMgYW5kIHRoZXJlZm9yZSBjYW5ub3QgYmUgYSBwcmludC9zdGF0dXMtd3JpdGUgc3RhbGUgZ3VhcmQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaExpdmVPcmRlclN0YXR1cyhcbiAga2luZDogXCJpbnZvaWNlXCIgfCBcInF1b3RlXCIsXG4gIG9yZGVySWQ6IHN0cmluZyxcbiAgY2xpZW50OiBMaXZlT3JkZXJRdWVyeUNsaWVudCA9IGdldFByaW50YXZvQ2xpZW50KCksXG4pOiBQcm9taXNlPExpdmVPcmRlclN0YXR1cyB8IG51bGw+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGNsaWVudC5xdWVyeTxTaW5nbGVPcmRlclN0YXR1cz4oXG4gICAgc2luZ2xlT3JkZXJTdGF0dXNRdWVyeShraW5kLCBvcmRlcklkKSxcbiAgKTtcbiAgY29uc3Qgbm9kZSA9IGRhdGFba2luZF0gPz8gbnVsbDtcbiAgaWYgKCFub2RlKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICBvcmRlcklkOiBub2RlLmlkLFxuICAgIHZpc3VhbElkOiBub3JtYWxpemVWaXN1YWxJZChub2RlLnZpc3VhbElkKSxcbiAgICBzdGF0dXNJZDogbm9kZS5zdGF0dXM/LmlkID8/IG51bGwsXG4gICAgc3RhdHVzTmFtZTogbm9kZS5zdGF0dXM/Lm5hbWUgPz8gbnVsbCxcbiAgfTtcbn1cblxuLyoqIEV4YWN0IGlkZW50aXR5ICsgc291cmNlLXN0YXR1cyBmZW5jZSB1c2VkIGltbWVkaWF0ZWx5IGJlZm9yZSBzaWRlIGVmZmVjdHMuICovXG5leHBvcnQgZnVuY3Rpb24gbGl2ZU9yZGVyU3RhdHVzTWF0Y2hlcyhcbiAgb2JzZXJ2ZWQ6IExpdmVPcmRlclN0YXR1cyB8IG51bGwsXG4gIGV4cGVjdGVkOiB7IG9yZGVySWQ6IHN0cmluZzsgdmlzdWFsSWQ6IG51bWJlcjsgc291cmNlU3RhdHVzSWQ6IHN0cmluZyB9LFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgb2JzZXJ2ZWQgIT09IG51bGwgJiZcbiAgICBvYnNlcnZlZC5vcmRlcklkID09PSBleHBlY3RlZC5vcmRlcklkICYmXG4gICAgb2JzZXJ2ZWQudmlzdWFsSWQgPT09IGV4cGVjdGVkLnZpc3VhbElkICYmXG4gICAgb2JzZXJ2ZWQuc3RhdHVzSWQgPT09IGV4cGVjdGVkLnNvdXJjZVN0YXR1c0lkXG4gICk7XG59XG5cbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShlcnI6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xufVxuXG5mdW5jdGlvbiBpc1Vuc3VwcG9ydGVkU3RhdHVzRmlsdGVyKGVycjogdW5rbm93bik6IGJvb2xlYW4ge1xuICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycikudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIChcbiAgICBtZXNzYWdlLmluY2x1ZGVzKFwic3RhdHVzaWRzXCIpICYmXG4gICAgKG1lc3NhZ2UuaW5jbHVkZXMoXCJ1bmtub3duIGFyZ3VtZW50XCIpIHx8XG4gICAgICBtZXNzYWdlLmluY2x1ZGVzKFwiYXJndW1lbnRcIikgfHxcbiAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoXCJmaWVsZFwiKSB8fFxuICAgICAgbWVzc2FnZS5pbmNsdWRlcyhcImNhbm5vdCBxdWVyeVwiKSlcbiAgKTtcbn1cblxuZnVuY3Rpb24gdW5zdXBwb3J0ZWRGaWx0ZXJFcnJvcihlcnI6IHVua25vd24pOiBMaXZlRGlzY292ZXJ5RXJyb3Ige1xuICByZXR1cm4gbmV3IExpdmVEaXNjb3ZlcnlFcnJvcihcbiAgICBbXG4gICAgICBcIlByaW50YXZvIGRvZXMgbm90IHN1cHBvcnQgc3RhdHVzLXNjb3BlZCBsaXZlIGRpc2NvdmVyeSAoc3RhdHVzSWRzKVwiLFxuICAgICAgXCJmb3IgdGhpcyBhY2NvdW50L3NjaGVtYTsgYXV0by1wcmludCB3YXMgYWJvcnRlZCBiZWZvcmUgYW55IGZhbGxiYWNrXCIsXG4gICAgICBcImNyYXdsLiBWZXJpZnkgdGhlIHYyIHNjaGVtYSBvciBhZGQgYSBzdXBwb3J0ZWQgc3RhdHVzIGZpbHRlciBiZWZvcmVcIixcbiAgICAgIFwidXNpbmcgYW4gZXhwZW5zaXZlIGhpc3RvcmljYWwgd29ya2Fyb3VuZC4gVXBzdHJlYW0gZXJyb3I6XCIsXG4gICAgICBlcnJvck1lc3NhZ2UoZXJyKSxcbiAgICBdLmpvaW4oXCIgXCIpLFxuICAgIFwidW5zdXBwb3J0ZWRfZmlsdGVyXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGludmFsaWRSZXNwb25zZShcbiAga2luZDogT3JkZXJLaW5kLFxuICBwYWdlOiBudW1iZXIsXG4gIHJlYXNvbjogc3RyaW5nLFxuKTogTGl2ZURpc2NvdmVyeUVycm9yIHtcbiAgcmV0dXJuIG5ldyBMaXZlRGlzY292ZXJ5RXJyb3IoXG4gICAgYExpdmUgYXV0by1wcmludCBkaXNjb3ZlcnkgcmV0dXJuZWQgYW4gaW52YWxpZCAke2tpbmR9IHBhZ2UgJHtwYWdlfTogJHtyZWFzb259YCxcbiAgICBcImludmFsaWRfcmVzcG9uc2VcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gcmVhZENvbm5lY3Rpb24oXG4gIGtpbmQ6IE9yZGVyS2luZCxcbiAgZGF0YTogdW5rbm93bixcbiAgcGFnZTogbnVtYmVyLFxuKTogQ29ubmVjdGlvbjxQdk9yZGVyTm9kZT4ge1xuICBjb25zdCBrZXkgPSBraW5kID09PSBcImludm9pY2VzXCIgPyBcImludm9pY2VzXCIgOiBcInF1b3Rlc1wiO1xuICBjb25zdCBjb25uZWN0aW9uID0gKGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHwgdW5kZWZpbmVkKT8uW2tleV07XG4gIGlmICghY29ubmVjdGlvbiB8fCB0eXBlb2YgY29ubmVjdGlvbiAhPT0gXCJvYmplY3RcIikge1xuICAgIHRocm93IGludmFsaWRSZXNwb25zZShraW5kLCBwYWdlLCBgbWlzc2luZyAke2tleX0gY29ubmVjdGlvbmApO1xuICB9XG4gIGNvbnN0IHZhbHVlID0gY29ubmVjdGlvbiBhcyB7XG4gICAgbm9kZXM/OiB1bmtub3duO1xuICAgIHBhZ2VJbmZvPzogeyBoYXNOZXh0UGFnZT86IHVua25vd247IGVuZEN1cnNvcj86IHVua25vd24gfTtcbiAgfTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlLm5vZGVzKSkge1xuICAgIHRocm93IGludmFsaWRSZXNwb25zZShraW5kLCBwYWdlLCBcIm5vZGVzIGlzIG5vdCBhbiBhcnJheVwiKTtcbiAgfVxuICBpZiAoXG4gICAgIXZhbHVlLnBhZ2VJbmZvIHx8XG4gICAgdHlwZW9mIHZhbHVlLnBhZ2VJbmZvLmhhc05leHRQYWdlICE9PSBcImJvb2xlYW5cIiB8fFxuICAgICh2YWx1ZS5wYWdlSW5mby5lbmRDdXJzb3IgIT09IG51bGwgJiZcbiAgICAgIHR5cGVvZiB2YWx1ZS5wYWdlSW5mby5lbmRDdXJzb3IgIT09IFwic3RyaW5nXCIpXG4gICkge1xuICAgIHRocm93IGludmFsaWRSZXNwb25zZShraW5kLCBwYWdlLCBcInBhZ2VJbmZvIGlzIGluY29tcGxldGVcIik7XG4gIH1cbiAgcmV0dXJuIHZhbHVlIGFzIENvbm5lY3Rpb248UHZPcmRlck5vZGU+O1xufVxuXG4vKipcbiAqIFJlYWQgZXZlcnkgcGFnZSBvZiBpbnZvaWNlcyBhbmQgcXVvdGVzIHRoYXQgUHJpbnRhdm8gc2F5cyBjdXJyZW50bHkgaGFzXG4gKiBvbmUgb2YgdGhlIGNvbmZpZ3VyZWQgc291cmNlIHN0YXR1c2VzLiBUaGVyZSBpcyBpbnRlbnRpb25hbGx5IG5vIGNyZWF0ZWQtYXRcbiAqIGN1dG9mZiwgdmlzdWFsLWlkIGN1dG9mZiwgb3IgZWFybHktc3RvcCBoZXVyaXN0aWMgaGVyZTogYSBzdGF0dXMgdHJhbnNpdGlvblxuICogb24gYW4gb2xkIGludm9pY2UgbXVzdCBiZSBkaXNjb3ZlcmFibGUgb24gdGhlIGZpcnN0IHJ1bi5cbiAqXG4gKiBgc3RhdHVzSWRzYCBpcyBzdXBwb3J0ZWQgYnkgdGhlIGxpdmUgdjIgc2NoZW1hIG9uIGJvdGggcm9vdCBjb25uZWN0aW9uc1xuICogKHZlcmlmaWVkIHdpdGggcmVhZC1vbmx5IGludHJvc3BlY3Rpb24pLiBJZiB0aGF0IGNhcGFiaWxpdHkgZGlzYXBwZWFycyxcbiAqIHRoaXMgZnVuY3Rpb24gZmFpbHMgY2xvc2VkIGFuZCBkb2VzIG5vdCBmYWxsIGJhY2sgdG8gYSBmdWxsIGhpc3RvcmljYWxcbiAqIGNyYXdsLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGlzY292ZXJMaXZlQXV0b1ByaW50T3JkZXJzKFxuICBzdGF0dXNJZHM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBjbGllbnQ6IExpdmVPcmRlclF1ZXJ5Q2xpZW50ID0gZ2V0UHJpbnRhdm9DbGllbnQoKSxcbik6IFByb21pc2U8TGl2ZURpc2NvdmVyeVJlc3VsdD4ge1xuICBjb25zdCB3YW50ZWRTdGF0dXNlcyA9IG5ldyBTZXQoXG4gICAgc3RhdHVzSWRzLmZpbHRlcigoc3RhdHVzSWQpID0+IHN0YXR1c0lkLnRyaW0oKS5sZW5ndGggPiAwKSxcbiAgKTtcbiAgaWYgKHdhbnRlZFN0YXR1c2VzLnNpemUgPT09IDApIHtcbiAgICB0aHJvdyBuZXcgTGl2ZURpc2NvdmVyeUVycm9yKFxuICAgICAgXCJMaXZlIGF1dG8tcHJpbnQgZGlzY292ZXJ5IHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBzb3VyY2Ugc3RhdHVzXCIsXG4gICAgICBcImludmFsaWRfcmVzcG9uc2VcIixcbiAgICApO1xuICB9XG5cbiAgY29uc3QgYnlWaXN1YWwgPSBuZXcgTWFwPG51bWJlciwgTGl2ZUF1dG9QcmludE9yZGVyPigpO1xuICBjb25zdCBwYWdlczogUmVjb3JkPFwiaW52b2ljZXNcIiB8IFwicXVvdGVzXCIsIG51bWJlcj4gPSB7XG4gICAgaW52b2ljZXM6IDAsXG4gICAgcXVvdGVzOiAwLFxuICB9O1xuXG4gIGZvciAoY29uc3Qga2luZCBvZiBbXCJpbnZvaWNlc1wiLCBcInF1b3Rlc1wiXSBhcyBjb25zdCkge1xuICAgIGxldCBjdXJzb3I6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGNvbnN0IHNlZW5DdXJzb3JzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgcGFnZU51bWJlciA9IHBhZ2VzW2tpbmRdICsgMTtcbiAgICAgIGxldCBkYXRhOiBJbnZvaWNlc1BhZ2UgfCBRdW90ZXNQYWdlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcXVlcnkgPVxuICAgICAgICAgIGtpbmQgPT09IFwiaW52b2ljZXNcIlxuICAgICAgICAgICAgPyBpbnZvaWNlc1BhZ2VRdWVyeSh7XG4gICAgICAgICAgICAgICAgYWZ0ZXI6IGN1cnNvcixcbiAgICAgICAgICAgICAgICBzdGF0dXNJZHM6IFsuLi53YW50ZWRTdGF0dXNlc10sXG4gICAgICAgICAgICAgICAgc29ydERlc2NlbmRpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgOiBxdW90ZXNQYWdlUXVlcnkoe1xuICAgICAgICAgICAgICAgIGFmdGVyOiBjdXJzb3IsXG4gICAgICAgICAgICAgICAgc3RhdHVzSWRzOiBbLi4ud2FudGVkU3RhdHVzZXNdLFxuICAgICAgICAgICAgICAgIHNvcnREZXNjZW5kaW5nOiBmYWxzZSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgIGRhdGEgPSBhd2FpdCBjbGllbnQucXVlcnk8SW52b2ljZXNQYWdlIHwgUXVvdGVzUGFnZT4ocXVlcnkpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc1Vuc3VwcG9ydGVkU3RhdHVzRmlsdGVyKGVycikpIHtcbiAgICAgICAgICB0aHJvdyB1bnN1cHBvcnRlZEZpbHRlckVycm9yKGVycik7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IExpdmVEaXNjb3ZlcnlFcnJvcihcbiAgICAgICAgICBgTGl2ZSBhdXRvLXByaW50IGRpc2NvdmVyeSBmYWlsZWQgb24gJHtraW5kfSBwYWdlICR7cGFnZU51bWJlcn06ICR7ZXJyb3JNZXNzYWdlKGVycil9YCxcbiAgICAgICAgICBcInJlcXVlc3RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGFnZSA9IHJlYWRDb25uZWN0aW9uKGtpbmQsIGRhdGEsIHBhZ2VOdW1iZXIpO1xuICAgICAgcGFnZXNba2luZF0gPSBwYWdlTnVtYmVyO1xuICAgICAgZm9yIChjb25zdCByYXdOb2RlIG9mIHBhZ2Uubm9kZXMpIHtcbiAgICAgICAgaWYgKCFyYXdOb2RlIHx8IHR5cGVvZiByYXdOb2RlICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgdGhyb3cgaW52YWxpZFJlc3BvbnNlKGtpbmQsIHBhZ2VOdW1iZXIsIFwiYSBub2RlIGlzIG5vdCBhbiBvYmplY3RcIik7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgbm9kZSA9IHJhd05vZGUgYXMgUHZPcmRlck5vZGU7XG4gICAgICAgIGlmICh0eXBlb2Ygbm9kZS5pZCAhPT0gXCJzdHJpbmdcIiB8fCBub2RlLmlkLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIHRocm93IGludmFsaWRSZXNwb25zZShraW5kLCBwYWdlTnVtYmVyLCBcImEgbm9kZSBoYXMgbm8gaWRcIik7XG4gICAgICAgIH1cbiAgICAgICAgLy8gUHJpbnRhdm8ncyBHcmFwaFFMIHNjYWxhciBoYXMgcmV0dXJuZWQgdmlzdWFsSWQgYXMgYm90aCBhIG51bWJlclxuICAgICAgICAvLyBhbmQgYSBudW1lcmljIHN0cmluZyBhY3Jvc3MgYWNjb3VudHMvcmVwbGljYXMuIE5vcm1hbGl6ZSB0aGVcbiAgICAgICAgLy8gcmVzcG9uc2UgYmVmb3JlIGl0IHJlYWNoZXMgdGhlIG1pcnJvciBhbmQgZGVkdXBlIGxvZ2ljLlxuICAgICAgICBjb25zdCB2aXN1YWxJZCA9IG5vcm1hbGl6ZVZpc3VhbElkKFxuICAgICAgICAgIChub2RlIGFzIHVua25vd24gYXMgeyB2aXN1YWxJZD86IHVua25vd24gfSkudmlzdWFsSWQsXG4gICAgICAgICk7XG4gICAgICAgIGlmICh2aXN1YWxJZCA9PT0gbnVsbCkge1xuICAgICAgICAgIHRocm93IGludmFsaWRSZXNwb25zZShcbiAgICAgICAgICAgIGtpbmQsXG4gICAgICAgICAgICBwYWdlTnVtYmVyLFxuICAgICAgICAgICAgYG9yZGVyICR7bm9kZS5pZH0gaGFzIG5vIGludGVnZXIgdmlzdWFsSWRgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZE5vZGUgPSB7IC4uLm5vZGUsIHZpc3VhbElkIH07XG4gICAgICAgIGlmIChcbiAgICAgICAgICAhbm9kZS5zdGF0dXMgfHxcbiAgICAgICAgICB0eXBlb2Ygbm9kZS5zdGF0dXMuaWQgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgICAhd2FudGVkU3RhdHVzZXMuaGFzKG5vZGUuc3RhdHVzLmlkKVxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBEbyBub3QgdHJ1c3QgYW4gQVBJIHJlc3BvbnNlIHRoYXQgaWdub3JlcyB0aGUgc3RhdHVzSWRzIGFyZ3VtZW50OlxuICAgICAgICAgIC8vIGFjY2VwdGluZyBpdCB3b3VsZCByZWludHJvZHVjZSB0aGUgc3RhbGUtbG9jYWwtc3RhdHVzIGJ1Zy5cbiAgICAgICAgICB0aHJvdyBpbnZhbGlkUmVzcG9uc2UoXG4gICAgICAgICAgICBraW5kLFxuICAgICAgICAgICAgcGFnZU51bWJlcixcbiAgICAgICAgICAgIGBvcmRlciAke25vZGUuaWR9IGRpZCBub3QgbWF0Y2ggdGhlIHJlcXVlc3RlZCBzdGF0dXNJZHNgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBleGlzdGluZyA9IGJ5VmlzdWFsLmdldCh2aXN1YWxJZCk7XG4gICAgICAgIC8vIEEgcXVvdGUgY2FuIGNvZXhpc3QgYnJpZWZseSB3aXRoIGl0cyBpbnZvaWNlIGR1cmluZyBjb252ZXJzaW9uLiBUaGVcbiAgICAgICAgLy8gaW52b2ljZSBpcyB0aGUgcHJpbnRhYmxlL2xpdmUgd2lubmVyOyBwcmVzZXJ2aW5nIG9uZSB2aXN1YWwgaWQgaGVyZVxuICAgICAgICAvLyBhbHNvIHByZXZlbnRzIHR3byBzdWJtaXNzaW9ucyBpbiBvbmUgcnVuLlxuICAgICAgICBpZiAoIWV4aXN0aW5nIHx8IChleGlzdGluZy5raW5kID09PSBcInF1b3Rlc1wiICYmIGtpbmQgPT09IFwiaW52b2ljZXNcIikpIHtcbiAgICAgICAgICBieVZpc3VhbC5zZXQodmlzdWFsSWQsIHsga2luZCwgbm9kZTogbm9ybWFsaXplZE5vZGUgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKCFwYWdlLnBhZ2VJbmZvLmhhc05leHRQYWdlKSBicmVhaztcbiAgICAgIGNvbnN0IG5leHRDdXJzb3IgPSBwYWdlLnBhZ2VJbmZvLmVuZEN1cnNvcjtcbiAgICAgIGlmICghbmV4dEN1cnNvcikge1xuICAgICAgICB0aHJvdyBuZXcgTGl2ZURpc2NvdmVyeUVycm9yKFxuICAgICAgICAgIGBMaXZlIGF1dG8tcHJpbnQgZGlzY292ZXJ5IHdhcyBpbmNvbXBsZXRlOiAke2tpbmR9IHBhZ2UgJHtwYWdlTnVtYmVyfSByZXBvcnRlZCBoYXNOZXh0UGFnZSB3aXRob3V0IGFuIGVuZEN1cnNvcmAsXG4gICAgICAgICAgXCJpbmNvbXBsZXRlX3BhZ2luYXRpb25cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChuZXh0Q3Vyc29yID09PSBjdXJzb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IExpdmVEaXNjb3ZlcnlFcnJvcihcbiAgICAgICAgICBgTGl2ZSBhdXRvLXByaW50IGRpc2NvdmVyeSB3YXMgaW5jb21wbGV0ZTogJHtraW5kfSBwYWdlICR7cGFnZU51bWJlcn0gcmVwZWF0ZWQgaXRzIGN1cnNvcmAsXG4gICAgICAgICAgXCJpbmNvbXBsZXRlX3BhZ2luYXRpb25cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChzZWVuQ3Vyc29ycy5oYXMobmV4dEN1cnNvcikpIHtcbiAgICAgICAgdGhyb3cgbmV3IExpdmVEaXNjb3ZlcnlFcnJvcihcbiAgICAgICAgICBgTGl2ZSBhdXRvLXByaW50IGRpc2NvdmVyeSB3YXMgaW5jb21wbGV0ZTogJHtraW5kfSBwYWdpbmF0aW9uIGN1cnNvciBjeWNsZSBkZXRlY3RlZCBhdCAke25leHRDdXJzb3J9YCxcbiAgICAgICAgICBcImluY29tcGxldGVfcGFnaW5hdGlvblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgc2VlbkN1cnNvcnMuYWRkKG5leHRDdXJzb3IpO1xuICAgICAgY3Vyc29yID0gbmV4dEN1cnNvcjtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG9yZGVyczogWy4uLmJ5VmlzdWFsLnZhbHVlcygpXS5zb3J0KFxuICAgICAgKGEsIGIpID0+IGEubm9kZS52aXN1YWxJZCAtIGIubm9kZS52aXN1YWxJZCxcbiAgICApLFxuICAgIHBhZ2VzLFxuICB9O1xufSIsICIvKiogU2NoZWR1bGVyLW9ubHkgc2FmZXR5IGdhdGU7IG1hbnVhbCBzdGFydHMgcmVtYWluIGV4cGxpY2l0IG9wZXJhdG9yIGFjdGlvbnMuICovXG5leHBvcnQgZnVuY3Rpb24gc2NoZWR1bGVkQXV0b1ByaW50QWxsb3dlZChcbiAgZHJ5UnVuOiBib29sZWFuLFxuICBub2RlRW52ID0gcHJvY2Vzcy5lbnYuTk9ERV9FTlYsXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIG5vZGVFbnYgIT09IFwiZGV2ZWxvcG1lbnRcIiB8fCBkcnlSdW47XG59IiwgImltcG9ydCB7XG4gIGxpdmVPcmRlclN0YXR1c01hdGNoZXMsXG4gIHR5cGUgTGl2ZU9yZGVyU3RhdHVzLFxufSBmcm9tIFwiLi9saXZlRGlzY292ZXJ5XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJpbnRTYWZldHlDaGVjayB7XG4gIGRyeVJ1bjogYm9vbGVhbjtcbiAgb2JzZXJ2ZWRTdGF0dXM6IExpdmVPcmRlclN0YXR1cyB8IG51bGw7XG4gIGV4cGVjdGVkOiB7XG4gICAgb3JkZXJJZDogc3RyaW5nO1xuICAgIHZpc3VhbElkOiBudW1iZXI7XG4gICAgc291cmNlU3RhdHVzSWQ6IHN0cmluZztcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcmludFNhZmV0eVJlc3VsdCB7XG4gIGFsbG93ZWQ6IGJvb2xlYW47XG4gIHJlYXNvbjogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqXG4gKiBTaW5nbGUgc2lkZS1lZmZlY3QgZ2F0ZSBmb3IgUHJpbnROb2RlLiBEcnkgcnVucyBuZXZlciBwYXNzIHRoaXMgZ2F0ZSwgYW5kIGFcbiAqIHJlYWwgcnVuIHJlcXVpcmVzIHRoZSBleGFjdCBsaXZlIGlkICsgdmlzdWFsIGlkICsgc291cmNlIHN0YXR1cyBpbW1lZGlhdGVseVxuICogYmVmb3JlIHN1Ym1pc3Npb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja1ByaW50U2FmZXR5KFxuICBpbnB1dDogUHJpbnRTYWZldHlDaGVjayxcbik6IFByaW50U2FmZXR5UmVzdWx0IHtcbiAgaWYgKGlucHV0LmRyeVJ1bikge1xuICAgIHJldHVybiB7IGFsbG93ZWQ6IGZhbHNlLCByZWFzb246IFwiRHJ5IHJ1biBcdTIwMTQgUHJpbnROb2RlIHN1Ym1pc3Npb24gZGlzYWJsZWRcIiB9O1xuICB9XG4gIGlmIChcbiAgICAhbGl2ZU9yZGVyU3RhdHVzTWF0Y2hlcyhpbnB1dC5vYnNlcnZlZFN0YXR1cywgaW5wdXQuZXhwZWN0ZWQpXG4gICkge1xuICAgIHJldHVybiB7XG4gICAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICAgIHJlYXNvbjpcbiAgICAgICAgXCJMaXZlIG9yZGVyIGlkZW50aXR5L3N0YXR1cyBjaGFuZ2VkIG9yIGNvdWxkIG5vdCBiZSB2ZXJpZmllZDsgUHJpbnROb2RlIHN1Ym1pc3Npb24gcmVmdXNlZFwiLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgYWxsb3dlZDogdHJ1ZSwgcmVhc29uOiBudWxsIH07XG59IiwgImV4cG9ydCBpbnRlcmZhY2UgQXV0b1ByaW50SWRlbnRpdHkge1xuICBvcmRlcklkOiBzdHJpbmc7XG4gIHZpc3VhbElkOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1ByaW50Q2FuZGlkYXRlUGxhbjxUPiB7XG4gIHNlbGVjdGVkOiBUW107XG4gIGFscmVhZHlQcmludGVkOiBudW1iZXI7XG4gIGRlZmVycmVkOiBudW1iZXI7XG59XG5cbi8qKlxuICogSGlzdG9yeSBkZWR1cCBhbmQgdGhlIHBlci1ydW4gZGV0YWlsIGNhcCBkZWxpYmVyYXRlbHkgaGFwcGVuIGJlZm9yZSBhbnlcbiAqIGRldGFpbCBmZXRjaC4gS2VlcGluZyB0aGlzIHB1cmUgbWFrZXMgdGhlIGV4cGVuc2l2ZS13b3JrIG9yZGVyaW5nXG4gKiBleGVjdXRhYmxlIGluIGZvY3VzZWQgdGVzdHMgd2l0aG91dCB0b3VjaGluZyBQcmludE5vZGUgb3IgdGhlIGRhdGFiYXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhbkF1dG9QcmludERldGFpbHM8VD4oXG4gIG9yZGVyczogcmVhZG9ubHkgVFtdLFxuICBpZGVudGl0eU9mOiAob3JkZXI6IFQpID0+IEF1dG9QcmludElkZW50aXR5LFxuICBwcmludGVkSWRzOiBSZWFkb25seVNldDxzdHJpbmc+LFxuICBwcmludGVkVmlzdWFsczogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbiAgbWF4T3JkZXJzOiBudW1iZXIsXG4pOiBBdXRvUHJpbnRDYW5kaWRhdGVQbGFuPFQ+IHtcbiAgY29uc3QgdW5wcmludGVkOiBUW10gPSBbXTtcbiAgbGV0IGFscmVhZHlQcmludGVkID0gMDtcbiAgZm9yIChjb25zdCBvcmRlciBvZiBvcmRlcnMpIHtcbiAgICBjb25zdCBpZGVudGl0eSA9IGlkZW50aXR5T2Yob3JkZXIpO1xuICAgIGlmIChcbiAgICAgIHByaW50ZWRJZHMuaGFzKGlkZW50aXR5Lm9yZGVySWQpIHx8XG4gICAgICBwcmludGVkVmlzdWFscy5oYXMoU3RyaW5nKGlkZW50aXR5LnZpc3VhbElkKSlcbiAgICApIHtcbiAgICAgIGFscmVhZHlQcmludGVkICs9IDE7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdW5wcmludGVkLnB1c2gob3JkZXIpO1xuICB9XG4gIGNvbnN0IHNlbGVjdGVkID0gdW5wcmludGVkLnNsaWNlKDAsIE1hdGgubWF4KDAsIG1heE9yZGVycykpO1xuICByZXR1cm4ge1xuICAgIHNlbGVjdGVkLFxuICAgIGFscmVhZHlQcmludGVkLFxuICAgIGRlZmVycmVkOiBNYXRo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
