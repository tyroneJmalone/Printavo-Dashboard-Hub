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

// src/lib/purchasing/internalInvoicePolicy.ts
function isInternalReplacementInvoice(visualId) {
  return Number(visualId) === 22787;
}

// src/lib/printQueue/autoPrint/printSafety.ts
function checkPrintSafety(input) {
  if (isInternalReplacementInvoice(input.expected.visualId) || isInternalReplacementInvoice(input.observedStatus?.visualId)) {
    return {
      allowed: false,
      reason: "Internal replacements invoice #22787 needs no AutoPrint workorder"
    };
  }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidGVzdHMvYXV0b1ByaW50TGl2ZURpc2NvdmVyeS50ZXN0LnRzIiwgIi4uLy4uL2xpYi9wcmludGF2by9zcmMvdGhyb3R0bGUudHMiLCAiLi4vLi4vbGliL3ByaW50YXZvL3NyYy9jbGllbnQudHMiLCAiLi4vLi4vbGliL3ByaW50YXZvL3NyYy9xdWVyaWVzLnRzIiwgInNyYy9saWIvcHJpbnRhdm9HYXRld2F5LnRzIiwgInNyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvbGl2ZURpc2NvdmVyeS50cyIsICJzcmMvbGliL3ByaW50UXVldWUvYXV0b1ByaW50L3NjaGVkdWxlclNhZmV0eS50cyIsICJzcmMvbGliL3B1cmNoYXNpbmcvaW50ZXJuYWxJbnZvaWNlUG9saWN5LnRzIiwgInNyYy9saWIvcHJpbnRRdWV1ZS9hdXRvUHJpbnQvcHJpbnRTYWZldHkudHMiLCAic3JjL2xpYi9wcmludFF1ZXVlL2F1dG9QcmludC9jYW5kaWRhdGVQbGFubmluZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQge1xuICBkaXNjb3ZlckxpdmVBdXRvUHJpbnRPcmRlcnMsXG4gIGZldGNoTGl2ZU9yZGVyU3RhdHVzLFxuICBMaXZlRGlzY292ZXJ5RXJyb3IsXG4gIGxpdmVPcmRlclN0YXR1c01hdGNoZXMsXG4gIHR5cGUgTGl2ZU9yZGVyUXVlcnlDbGllbnQsXG59IGZyb20gXCIuLi9zcmMvbGliL3ByaW50UXVldWUvYXV0b1ByaW50L2xpdmVEaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IHNjaGVkdWxlZEF1dG9QcmludEFsbG93ZWQgfSBmcm9tIFwiLi4vc3JjL2xpYi9wcmludFF1ZXVlL2F1dG9QcmludC9zY2hlZHVsZXJTYWZldHkudHNcIjtcbmltcG9ydCB7IGNoZWNrUHJpbnRTYWZldHkgfSBmcm9tIFwiLi4vc3JjL2xpYi9wcmludFF1ZXVlL2F1dG9QcmludC9wcmludFNhZmV0eS50c1wiO1xuaW1wb3J0IHsgcGxhbkF1dG9QcmludERldGFpbHMgfSBmcm9tIFwiLi4vc3JjL2xpYi9wcmludFF1ZXVlL2F1dG9QcmludC9jYW5kaWRhdGVQbGFubmluZy50c1wiO1xuaW1wb3J0IHR5cGUgeyBQdk9yZGVyTm9kZSB9IGZyb20gXCJAd29ya3NwYWNlL3ByaW50YXZvXCI7XG5cbmNvbnN0IFNPVVJDRV9TVEFUVVMgPSBcIjU0NTE2MVwiO1xuY29uc3QgT1RIRVJfU1RBVFVTID0gXCIxMjNcIjtcblxuZnVuY3Rpb24gbm9kZShcbiAgaWQ6IHN0cmluZyxcbiAgdmlzdWFsSWQ6IG51bWJlcixcbiAgc3RhdHVzSWQgPSBTT1VSQ0VfU1RBVFVTLFxuKTogUHZPcmRlck5vZGUge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIHZpc3VhbElkLFxuICAgIG5pY2tuYW1lOiBgb3JkZXItJHt2aXN1YWxJZH1gLFxuICAgIHRvdGFsOiBudWxsLFxuICAgIHN1YnRvdGFsOiBudWxsLFxuICAgIGFtb3VudFBhaWQ6IG51bGwsXG4gICAgYW1vdW50T3V0c3RhbmRpbmc6IG51bGwsXG4gICAgY3VzdG9tZXJEdWVBdDogbnVsbCxcbiAgICBpbnZvaWNlQXQ6IG51bGwsXG4gICAgZHVlQXQ6IG51bGwsXG4gICAgcGF5bWVudER1ZUF0OiBudWxsLFxuICAgIHB1YmxpY1VybDogbnVsbCxcbiAgICB3b3Jrb3JkZXJVcmw6IGBodHRwczovL3Nob3AucHJpbnRhdm8uY29tL3dvcmtfb3JkZXJzLyR7aWR9YCxcbiAgICBjdXN0b21lck5vdGU6IG51bGwsXG4gICAgcHJvZHVjdGlvbk5vdGU6IG51bGwsXG4gICAgdmlzdWFsUG9OdW1iZXI6IG51bGwsXG4gICAgdGFnczogbnVsbCxcbiAgICBzdGF0dXM6IHsgaWQ6IHN0YXR1c0lkLCBuYW1lOiBzdGF0dXNJZCA9PT0gU09VUkNFX1NUQVRVUyA/IFwiUHJpbnQgRXJyb3IgLSBSZXZpZXdcIiA6IFwiTW92ZWQgT3V0XCIgfSxcbiAgICBvd25lcjogbnVsbCxcbiAgICBjb250YWN0OiBudWxsLFxuICAgIHNoaXBwaW5nQWRkcmVzczogbnVsbCxcbiAgICBiaWxsaW5nQWRkcmVzczogbnVsbCxcbiAgICBkZWxpdmVyeU1ldGhvZDogbnVsbCxcbiAgICBwYXltZW50VGVybTogbnVsbCxcbiAgICB0aW1lc3RhbXBzOiB7XG4gICAgICAvLyBUaGlzIGlzIGludGVudGlvbmFsbHkgb2xkOiBsaXZlIGRpc2NvdmVyeSBtdXN0IG5vdCBhcHBseSBhbiBhZ2VcbiAgICAgIC8vIGN1dG9mZiB3aGlsZSBsb29raW5nIGZvciBhIG5ld2x5IHN0YXR1c2VkIGludm9pY2UuXG4gICAgICBjcmVhdGVkQXQ6IFwiMjAyNS0wNy0yMlQwMDowMDowMFpcIixcbiAgICAgIHVwZGF0ZWRBdDogXCIyMDI2LTA5LTE1VDAwOjAwOjAwWlwiLFxuICAgIH0sXG4gIH07XG59XG5cbmNsYXNzIEZha2VDbGllbnQgaW1wbGVtZW50cyBMaXZlT3JkZXJRdWVyeUNsaWVudCB7XG4gIHJlYWRvbmx5IHF1ZXJpZXM6IHN0cmluZ1tdID0gW107XG4gIHByaXZhdGUgcmVhZG9ubHkgcGFnZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd25bXT47XG4gIHByaXZhdGUgcmVhZG9ubHkgZmFpbHVyZT86IEVycm9yO1xuXG4gIGNvbnN0cnVjdG9yKHBhZ2VzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duW10+LCBmYWlsdXJlPzogRXJyb3IpIHtcbiAgICB0aGlzLnBhZ2VzID0gcGFnZXM7XG4gICAgdGhpcy5mYWlsdXJlID0gZmFpbHVyZTtcbiAgfVxuXG4gIGFzeW5jIHF1ZXJ5PFQ+KHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPFQ+IHtcbiAgICB0aGlzLnF1ZXJpZXMucHVzaChxdWVyeSk7XG4gICAgaWYgKHRoaXMuZmFpbHVyZSkgdGhyb3cgdGhpcy5mYWlsdXJlO1xuICAgIGNvbnN0IGtpbmQgPSBxdWVyeS5pbmNsdWRlcyhcImludm9pY2VzKFwiKSA/IFwiaW52b2ljZXNcIiA6IFwicXVvdGVzXCI7XG4gICAgY29uc3QgYWZ0ZXIgPSBxdWVyeS5tYXRjaCgvYWZ0ZXI6IFwiKFteXCJdKylcIi8pPy5bMV0gPz8gXCJmaXJzdFwiO1xuICAgIGNvbnN0IHBhZ2UgPSB0aGlzLnBhZ2VzW2Ake2tpbmR9OiR7YWZ0ZXJ9YF0gPz8ge1xuICAgICAgbm9kZXM6IFtdLFxuICAgICAgcGFnZUluZm86IHsgaGFzTmV4dFBhZ2U6IGZhbHNlLCBlbmRDdXJzb3I6IG51bGwgfSxcbiAgICB9O1xuICAgIHJldHVybiB7IFtraW5kXTogcGFnZSB9IGFzIFQ7XG4gIH1cbn1cblxudGVzdChcInN0YXR1cy1zY29wZWQgbGl2ZSBkaXNjb3ZlcnkgZmluZHMgYW4gb2xkIGludm9pY2UgYW5kIG5ldmVyIHVzZXMgbG9jYWwgc3RhdHVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgb2xkSW52b2ljZSA9IHtcbiAgICAuLi5ub2RlKFwib2xkLWxpdmUtaW52b2ljZVwiLCAxODM3MSksXG4gICAgdmlzdWFsSWQ6IFwiMTgzNzFcIixcbiAgfSBhcyB1bmtub3duIGFzIFB2T3JkZXJOb2RlO1xuICBjb25zdCBjbGllbnQgPSBuZXcgRmFrZUNsaWVudCh7XG4gICAgXCJpbnZvaWNlczpmaXJzdFwiOiB7XG4gICAgICBub2RlczogW29sZEludm9pY2VdLFxuICAgICAgcGFnZUluZm86IHsgaGFzTmV4dFBhZ2U6IGZhbHNlLCBlbmRDdXJzb3I6IG51bGwgfSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNjb3ZlckxpdmVBdXRvUHJpbnRPcmRlcnMoW1NPVVJDRV9TVEFUVVNdLCBjbGllbnQpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgcmVzdWx0Lm9yZGVycy5tYXAoKG9yZGVyKSA9PiBvcmRlci5ub2RlLmlkKSxcbiAgICBbXCJvbGQtbGl2ZS1pbnZvaWNlXCJdLFxuICApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9yZGVyc1swXT8ubm9kZS52aXN1YWxJZCwgMTgzNzEpO1xuICBhc3NlcnQub2soY2xpZW50LnF1ZXJpZXNbMF0/LmluY2x1ZGVzKCdzdGF0dXNJZHM6IFtcIjU0NTE2MVwiXScpKTtcbiAgYXNzZXJ0Lm9rKCFjbGllbnQucXVlcmllc1swXT8uaW5jbHVkZXMoXCJpblByb2R1Y3Rpb25BZnRlclwiKSk7XG4gIGFzc2VydC5vayghY2xpZW50LnF1ZXJpZXNbMF0/LmluY2x1ZGVzKFwiaW5Qcm9kdWN0aW9uQmVmb3JlXCIpKTtcbiAgYXNzZXJ0Lm9rKCFjbGllbnQucXVlcmllc1swXT8uaW5jbHVkZXMoXCJ1cGRhdGVkQWZ0ZXJcIikpO1xufSk7XG5cbnRlc3QoXCJhIG1vdmVkLW91dCBsb2NhbCBjYW5kaWRhdGUgaXMgYWJzZW50IGZyb20gdGhlIGxpdmUgc2V0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEZha2VDbGllbnQoe1xuICAgIFwiaW52b2ljZXM6Zmlyc3RcIjoge1xuICAgICAgLy8gVGhlIG9sZCBsb2NhbCByb3cgaXMgZGVsaWJlcmF0ZWx5IG5vdCByZXR1cm5lZCBieSB0aGUgbGl2ZVxuICAgICAgLy8gc3RhdHVzLXNjb3BlZCBjb25uZWN0aW9uIGFmdGVyIGl0IG1vdmVkIG91dCBvZiB0aGUgc291cmNlIHN0YXR1cy5cbiAgICAgIG5vZGVzOiBbbm9kZShcInN0aWxsLWxpdmVcIiwgMTApXSxcbiAgICAgIHBhZ2VJbmZvOiB7IGhhc05leHRQYWdlOiBmYWxzZSwgZW5kQ3Vyc29yOiBudWxsIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGlzY292ZXJMaXZlQXV0b1ByaW50T3JkZXJzKFtTT1VSQ0VfU1RBVFVTXSwgY2xpZW50KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIHJlc3VsdC5vcmRlcnMubWFwKChvcmRlcikgPT4gb3JkZXIubm9kZS5pZCksXG4gICAgW1wic3RpbGwtbGl2ZVwiXSxcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgICFyZXN1bHQub3JkZXJzLnNvbWUoKG9yZGVyKSA9PiBvcmRlci5ub2RlLnN0YXR1cz8uaWQgPT09IE9USEVSX1NUQVRVUyksXG4gICk7XG59KTtcblxudGVzdChcInBhZ2luYXRpb24gaXMgY29tcGxldGUgYW5kIGR1cGxpY2F0ZSB2aXN1YWwgaWRzIHJlbWFpbiBvbmUgZGVkdXBlZCBjYW5kaWRhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgRmFrZUNsaWVudCh7XG4gICAgXCJpbnZvaWNlczpmaXJzdFwiOiB7XG4gICAgICBub2RlczogW25vZGUoXCJpbnZvaWNlLTE4MzcxXCIsIDE4MzcxKV0sXG4gICAgICBwYWdlSW5mbzogeyBoYXNOZXh0UGFnZTogdHJ1ZSwgZW5kQ3Vyc29yOiBcImludm9pY2UtbmV4dFwiIH0sXG4gICAgfSxcbiAgICBcImludm9pY2VzOmludm9pY2UtbmV4dFwiOiB7XG4gICAgICBub2RlczogW25vZGUoXCJpbnZvaWNlLTJcIiwgMildLFxuICAgICAgcGFnZUluZm86IHsgaGFzTmV4dFBhZ2U6IGZhbHNlLCBlbmRDdXJzb3I6IG51bGwgfSxcbiAgICB9LFxuICAgIFwicXVvdGVzOmZpcnN0XCI6IHtcbiAgICAgIG5vZGVzOiBbbm9kZShcInF1b3RlLTE4MzcxXCIsIDE4MzcxKV0sXG4gICAgICBwYWdlSW5mbzogeyBoYXNOZXh0UGFnZTogZmFsc2UsIGVuZEN1cnNvcjogbnVsbCB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRpc2NvdmVyTGl2ZUF1dG9QcmludE9yZGVycyhbU09VUkNFX1NUQVRVU10sIGNsaWVudCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wYWdlcy5pbnZvaWNlcywgMik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucGFnZXMucXVvdGVzLCAxKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICByZXN1bHQub3JkZXJzLm1hcCgob3JkZXIpID0+IG9yZGVyLm5vZGUuaWQpLFxuICAgIFtcImludm9pY2UtMlwiLCBcImludm9pY2UtMTgzNzFcIl0sXG4gICk7XG4gIGFzc2VydC5vayhjbGllbnQucXVlcmllc1swXT8uaW5jbHVkZXMoXCJzb3J0RGVzY2VuZGluZzogZmFsc2VcIikpO1xufSk7XG5cbnRlc3QoXCJpbmNvbXBsZXRlIHBhZ2luYXRpb24gZmFpbHMgY2xvc2VkIGJlZm9yZSBhbnkgcHJpbnQtY2FwYWJsZSBwaGFzZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBGYWtlQ2xpZW50KHtcbiAgICBcImludm9pY2VzOmZpcnN0XCI6IHtcbiAgICAgIG5vZGVzOiBbbm9kZShcIm9sZC1saXZlLWludm9pY2VcIiwgMTgzNzEpXSxcbiAgICAgIHBhZ2VJbmZvOiB7IGhhc05leHRQYWdlOiB0cnVlLCBlbmRDdXJzb3I6IG51bGwgfSxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICBkaXNjb3ZlckxpdmVBdXRvUHJpbnRPcmRlcnMoW1NPVVJDRV9TVEFUVVNdLCBjbGllbnQpLFxuICAgIChlcnI6IHVua25vd24pID0+XG4gICAgICBlcnIgaW5zdGFuY2VvZiBMaXZlRGlzY292ZXJ5RXJyb3IgJiZcbiAgICAgIGVyci5raW5kID09PSBcImluY29tcGxldGVfcGFnaW5hdGlvblwiICYmXG4gICAgICBlcnIubWVzc2FnZS5pbmNsdWRlcyhcImluY29tcGxldGVcIiksXG4gICk7XG59KTtcblxudGVzdChcInBhZ2luYXRpb24gY3Vyc29yIEEtQi1BIGN5Y2xlIGZhaWxzIGNsb3NlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBGYWtlQ2xpZW50KHtcbiAgICBcImludm9pY2VzOmZpcnN0XCI6IHtcbiAgICAgIG5vZGVzOiBbbm9kZShcInBhZ2UtYVwiLCAxKV0sXG4gICAgICBwYWdlSW5mbzogeyBoYXNOZXh0UGFnZTogdHJ1ZSwgZW5kQ3Vyc29yOiBcImN1cnNvci1hXCIgfSxcbiAgICB9LFxuICAgIFwiaW52b2ljZXM6Y3Vyc29yLWFcIjoge1xuICAgICAgbm9kZXM6IFtub2RlKFwicGFnZS1iXCIsIDIpXSxcbiAgICAgIHBhZ2VJbmZvOiB7IGhhc05leHRQYWdlOiB0cnVlLCBlbmRDdXJzb3I6IFwiY3Vyc29yLWJcIiB9LFxuICAgIH0sXG4gICAgXCJpbnZvaWNlczpjdXJzb3ItYlwiOiB7XG4gICAgICBub2RlczogW25vZGUoXCJwYWdlLWEtYWdhaW5cIiwgMyldLFxuICAgICAgcGFnZUluZm86IHsgaGFzTmV4dFBhZ2U6IHRydWUsIGVuZEN1cnNvcjogXCJjdXJzb3ItYVwiIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgZGlzY292ZXJMaXZlQXV0b1ByaW50T3JkZXJzKFtTT1VSQ0VfU1RBVFVTXSwgY2xpZW50KSxcbiAgICAoZXJyOiB1bmtub3duKSA9PlxuICAgICAgZXJyIGluc3RhbmNlb2YgTGl2ZURpc2NvdmVyeUVycm9yICYmXG4gICAgICBlcnIua2luZCA9PT0gXCJpbmNvbXBsZXRlX3BhZ2luYXRpb25cIiAmJlxuICAgICAgZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJjeWNsZVwiKSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwicmF0ZS9kaXNjb3ZlcnkgZmFpbHVyZSBmYWlscyBjbG9zZWQgcmF0aGVyIHRoYW4gdXNpbmcgY2FjaGVkIGNhbmRpZGF0ZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgRmFrZUNsaWVudCh7fSwgbmV3IEVycm9yKFwiUHJpbnRhdm8gcmF0ZSBsaW1pdCBoaXQgdHdpY2VcIikpO1xuXG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgIGRpc2NvdmVyTGl2ZUF1dG9QcmludE9yZGVycyhbU09VUkNFX1NUQVRVU10sIGNsaWVudCksXG4gICAgKGVycjogdW5rbm93bikgPT5cbiAgICAgIGVyciBpbnN0YW5jZW9mIExpdmVEaXNjb3ZlcnlFcnJvciAmJlxuICAgICAgZXJyLmtpbmQgPT09IFwicmVxdWVzdFwiICYmXG4gICAgICBlcnIubWVzc2FnZS5pbmNsdWRlcyhcInJhdGUgbGltaXRcIiksXG4gICk7XG59KTtcblxudGVzdChcInVuc3VwcG9ydGVkIHN0YXR1cyBmaWx0ZXJpbmcgcmVwb3J0cyBvcHRpb25zIGJlZm9yZSBhbnkgZmFsbGJhY2sgY3Jhd2xcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgRmFrZUNsaWVudChcbiAgICB7fSxcbiAgICBuZXcgRXJyb3IoXCJQcmludGF2byBHcmFwaFFMIGVycm9yOiBVbmtub3duIGFyZ3VtZW50IHN0YXR1c0lkc1wiKSxcbiAgKTtcblxuICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICBkaXNjb3ZlckxpdmVBdXRvUHJpbnRPcmRlcnMoW1NPVVJDRV9TVEFUVVNdLCBjbGllbnQpLFxuICAgIChlcnI6IHVua25vd24pID0+XG4gICAgICBlcnIgaW5zdGFuY2VvZiBMaXZlRGlzY292ZXJ5RXJyb3IgJiZcbiAgICAgIGVyci5raW5kID09PSBcInVuc3VwcG9ydGVkX2ZpbHRlclwiICYmXG4gICAgICBlcnIubWVzc2FnZS5pbmNsdWRlcyhcImJlZm9yZSBhbnkgZmFsbGJhY2sgY3Jhd2xcIiksXG4gICk7XG59KTtcblxudGVzdChcImRldmVsb3BtZW50IHNjaGVkdWxlciBibG9ja3MgbGl2ZSBydW5zIGJ1dCBwZXJtaXRzIGRyeSBydW5zIGFuZCBwcm9kdWN0aW9uXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKHNjaGVkdWxlZEF1dG9QcmludEFsbG93ZWQoZmFsc2UsIFwiZGV2ZWxvcG1lbnRcIiksIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHNjaGVkdWxlZEF1dG9QcmludEFsbG93ZWQodHJ1ZSwgXCJkZXZlbG9wbWVudFwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChzY2hlZHVsZWRBdXRvUHJpbnRBbGxvd2VkKGZhbHNlLCBcInByb2R1Y3Rpb25cIiksIHRydWUpO1xufSk7XG5cbnRlc3QoXCJQcmludE5vZGUgc2FmZXR5IGdhdGUgcmVqZWN0cyBpbnZhbGlkIGxpdmUgc3RhdHVzIGFuZCBmYWlsZWQgY2hlY2tzXCIsICgpID0+IHtcbiAgbGV0IHByaW50Tm9kZUNhbGxzID0gMDtcbiAgY29uc3QgZXhwZWN0ZWQgPSB7XG4gICAgb3JkZXJJZDogXCIxODgxNjUyOVwiLFxuICAgIHZpc3VhbElkOiAxODM3MSxcbiAgICBzb3VyY2VTdGF0dXNJZDogU09VUkNFX1NUQVRVUyxcbiAgfTtcbiAgY29uc3QgbW92ZWQgPSB7XG4gICAgb3JkZXJJZDogZXhwZWN0ZWQub3JkZXJJZCxcbiAgICB2aXN1YWxJZDogZXhwZWN0ZWQudmlzdWFsSWQsXG4gICAgc3RhdHVzSWQ6IE9USEVSX1NUQVRVUyxcbiAgICBzdGF0dXNOYW1lOiBcIk1vdmVkIE91dFwiLFxuICB9O1xuICBhc3NlcnQuZXF1YWwobGl2ZU9yZGVyU3RhdHVzTWF0Y2hlcyhtb3ZlZCwgZXhwZWN0ZWQpLCBmYWxzZSk7XG4gIGNvbnN0IGludmFsaWQgPSBjaGVja1ByaW50U2FmZXR5KHtcbiAgICBkcnlSdW46IGZhbHNlLFxuICAgIG9ic2VydmVkU3RhdHVzOiBtb3ZlZCxcbiAgICBleHBlY3RlZCxcbiAgfSk7XG4gIGlmIChpbnZhbGlkLmFsbG93ZWQpIHByaW50Tm9kZUNhbGxzICs9IDE7XG4gIGFzc2VydC5lcXVhbChpbnZhbGlkLmFsbG93ZWQsIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHByaW50Tm9kZUNhbGxzLCAwKTtcblxuICBjb25zdCBmYWlsZWQgPSBjaGVja1ByaW50U2FmZXR5KHtcbiAgICBkcnlSdW46IGZhbHNlLFxuICAgIG9ic2VydmVkU3RhdHVzOiBudWxsLFxuICAgIGV4cGVjdGVkLFxuICB9KTtcbiAgaWYgKGZhaWxlZC5hbGxvd2VkKSBwcmludE5vZGVDYWxscyArPSAxO1xuICBhc3NlcnQuZXF1YWwoZmFpbGVkLmFsbG93ZWQsIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHByaW50Tm9kZUNhbGxzLCAwKTtcbn0pO1xuXG50ZXN0KFwiZXhhY3Qgc3RhdHVzIGZlbmNlIG5vcm1hbGl6ZXMgUHJpbnRhdm8gbnVtZXJpYy1zdHJpbmcgdmlzdWFsIGlkc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudDogTGl2ZU9yZGVyUXVlcnlDbGllbnQgPSB7XG4gICAgYXN5bmMgcXVlcnk8VD4oKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBpbnZvaWNlOiB7XG4gICAgICAgICAgaWQ6IFwiMTg4MTY1MjlcIixcbiAgICAgICAgICB2aXN1YWxJZDogXCIxODM3MVwiLFxuICAgICAgICAgIHN0YXR1czogeyBpZDogU09VUkNFX1NUQVRVUywgbmFtZTogXCJQcmludCBFcnJvciAtIFJldmlld1wiIH0sXG4gICAgICAgIH0sXG4gICAgICB9IGFzIFQ7XG4gICAgfSxcbiAgfTtcbiAgY29uc3Qgb2JzZXJ2ZWQgPSBhd2FpdCBmZXRjaExpdmVPcmRlclN0YXR1cyhcImludm9pY2VcIiwgXCIxODgxNjUyOVwiLCBjbGllbnQpO1xuICBhc3NlcnQuZGVlcEVxdWFsKG9ic2VydmVkLCB7XG4gICAgb3JkZXJJZDogXCIxODgxNjUyOVwiLFxuICAgIHZpc3VhbElkOiAxODM3MSxcbiAgICBzdGF0dXNJZDogU09VUkNFX1NUQVRVUyxcbiAgICBzdGF0dXNOYW1lOiBcIlByaW50IEVycm9yIC0gUmV2aWV3XCIsXG4gIH0pO1xufSk7XG5cbnRlc3QoXCJkcnktcnVuIHNhZmV0eSBnYXRlIG5ldmVyIHBlcm1pdHMgUHJpbnROb2RlIGV2ZW4gd2l0aCBtYXRjaGluZyBsaXZlIHN0YXR1c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNoZWNrUHJpbnRTYWZldHkoe1xuICAgIGRyeVJ1bjogdHJ1ZSxcbiAgICBvYnNlcnZlZFN0YXR1czoge1xuICAgICAgb3JkZXJJZDogXCIxODgxNjUyOVwiLFxuICAgICAgdmlzdWFsSWQ6IDE4MzcxLFxuICAgICAgc3RhdHVzSWQ6IFNPVVJDRV9TVEFUVVMsXG4gICAgICBzdGF0dXNOYW1lOiBcIlByaW50IEVycm9yIC0gUmV2aWV3XCIsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgb3JkZXJJZDogXCIxODgxNjUyOVwiLFxuICAgICAgdmlzdWFsSWQ6IDE4MzcxLFxuICAgICAgc291cmNlU3RhdHVzSWQ6IFNPVVJDRV9TVEFUVVMsXG4gICAgfSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWxsb3dlZCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJwcmludGVkIGRlZHVwIGFuZCBNQVggY2FwIHNlbGVjdCBkZXRhaWwgd29yayBiZWZvcmUgZGV0YWlsIHJlcXVlc3RzXCIsICgpID0+IHtcbiAgY29uc3QgbGl2ZSA9IFtcbiAgICB7IG9yZGVySWQ6IFwicHJpbnRlZC1pZFwiLCB2aXN1YWxJZDogMSB9LFxuICAgIHsgb3JkZXJJZDogXCJvbGQtMlwiLCB2aXN1YWxJZDogMiB9LFxuICAgIHsgb3JkZXJJZDogXCJvbGQtM1wiLCB2aXN1YWxJZDogMyB9LFxuICAgIHsgb3JkZXJJZDogXCJvbGQtNFwiLCB2aXN1YWxJZDogNCB9LFxuICAgIHsgb3JkZXJJZDogXCJjb252ZXJ0ZWQtbmV3LWlkXCIsIHZpc3VhbElkOiA1IH0sXG4gIF07XG4gIGNvbnN0IHBsYW4gPSBwbGFuQXV0b1ByaW50RGV0YWlscyhcbiAgICBsaXZlLFxuICAgIChvcmRlcikgPT4gb3JkZXIsXG4gICAgbmV3IFNldChbXCJwcmludGVkLWlkXCJdKSxcbiAgICBuZXcgU2V0KFtcIjVcIl0pLFxuICAgIDIsXG4gICk7XG4gIGNvbnN0IGRldGFpbFJlcXVlc3RzID0gcGxhbi5zZWxlY3RlZC5tYXAoKG9yZGVyKSA9PiBvcmRlci5vcmRlcklkKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChkZXRhaWxSZXF1ZXN0cywgW1wib2xkLTJcIiwgXCJvbGQtM1wiXSk7XG4gIGFzc2VydC5lcXVhbChwbGFuLmFscmVhZHlQcmludGVkLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKHBsYW4uZGVmZXJyZWQsIDEpO1xufSk7IiwgImV4cG9ydCBmdW5jdGlvbiBzbGVlcChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xufVxuXG4vKipcbiAqIFNlcmlhbGl6ZXMgYWxsIHJlcXVlc3RzIHRocm91Z2ggYSBzaW5nbGUgcHJvbWlzZSBjaGFpbiBhbmQgZW5mb3JjZXMgYVxuICogbWluaW11bSBpbnRlcnZhbCBiZXR3ZWVuIHRoZSBFTkQgb2Ygb25lIHJlcXVlc3QgYW5kIHRoZSBTVEFSVCBvZiB0aGUgbmV4dC5cbiAqXG4gKiBJTlZBUklBTlQ6IHRoaXMgZ2F0ZSBpcyBpbi1wcm9jZXNzIG9ubHkuIEl0IGlzIHNhZmUgb25seSB3aGlsZSBldmVyeVxuICogUHJpbnRhdm8gY2FsbCBpbiB0aGUgYWNjb3VudCBmbG93cyB0aHJvdWdoIE9ORSBhcGktc2VydmVyIHByb2Nlc3MuXG4gKi9cbmV4cG9ydCBjbGFzcyBSZXF1ZXN0R2F0ZSB7XG4gIHByaXZhdGUgcXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgcHJpdmF0ZSBsYXN0UmVxdWVzdEVuZGVkQXQgPSAwO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgbWluSW50ZXJ2YWxNczogbnVtYmVyKSB7fVxuXG4gIHNjaGVkdWxlPFQ+KGZuOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gICAgY29uc3QgcnVuID0gdGhpcy5xdWV1ZS50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHdhaXQgPSB0aGlzLmxhc3RSZXF1ZXN0RW5kZWRBdCArIHRoaXMubWluSW50ZXJ2YWxNcyAtIERhdGUubm93KCk7XG4gICAgICBpZiAod2FpdCA+IDApIHtcbiAgICAgICAgYXdhaXQgc2xlZXAod2FpdCk7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgZm4oKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHRoaXMubGFzdFJlcXVlc3RFbmRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0aGlzLnF1ZXVlID0gcnVuLnRoZW4oXG4gICAgICAoKSA9PiB1bmRlZmluZWQsXG4gICAgICAoKSA9PiB1bmRlZmluZWQsXG4gICAgKTtcbiAgICByZXR1cm4gcnVuO1xuICB9XG59XG4iLCAiaW1wb3J0IHsgUmVxdWVzdEdhdGUsIHNsZWVwIH0gZnJvbSBcIi4vdGhyb3R0bGVcIjtcblxuZXhwb3J0IGNvbnN0IFBSSU5UQVZPX0VORFBPSU5UID0gXCJodHRwczovL3d3dy5wcmludGF2by5jb20vYXBpL3YyXCI7XG5cbi8qKiB+OCByZXEgLyA1cy4gNTUwbXMgdHJpcHBlZCByZWFsIDQyOXMgb24gYnVyc3RzOyA2MjBtcyBpcyB0aGUgcHJvdmVuLXNhZmUgc3BhY2luZy4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSU5URVJWQUxfTVMgPSA2MjA7XG5cbi8qKiBDb29sZG93biBiZWZvcmUgdGhlIHNpbmdsZSByZXRyeSBhZnRlciBhIDQyOS4gKi9cbmV4cG9ydCBjb25zdCBSRVRSWV9BRlRFUl80MjlfTVMgPSA1MjAwO1xuXG4vKipcbiAqIFByaW50YXZvIHNwb3JhZGljYWxseSByZXR1cm5zIHRyYW5zaWVudCBzZXJ2ZXItc2lkZSB0aW1lb3V0cyBhcyBHcmFwaFFMXG4gKiBlcnJvcnMgaW4gYW4gSFRUUCAyMDAgKG9ic2VydmVkOiBcIlRpbWVvdXQgb24gSURlZC5pZFwiKS4gUXVlcmllcyBhcmVcbiAqIHJlYWQtb25seSwgc28gcmUtc2VuZGluZyBpcyBzYWZlIFx1MjAxNCByZXRyeSB3aXRoIGJhY2tvZmYgaW5zdGVhZCBvZlxuICogZmFpbGluZyBhIHdob2xlIHN5bmMgcnVuLlxuICovXG5leHBvcnQgY29uc3QgR1JBUEhRTF9USU1FT1VUX1JFVFJZX0RFTEFZU19NUyA9IFs1XzAwMCwgMTVfMDAwLCAzMF8wMDBdO1xuXG5mdW5jdGlvbiBpc1RyYW5zaWVudFRpbWVvdXQoZXJyb3JzOiBBcnJheTx7IG1lc3NhZ2U/OiBzdHJpbmcgfT4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGVycm9ycy5ldmVyeShcbiAgICAoZSkgPT4gdHlwZW9mIGUubWVzc2FnZSA9PT0gXCJzdHJpbmdcIiAmJiBlLm1lc3NhZ2Uuc3RhcnRzV2l0aChcIlRpbWVvdXQgb25cIiksXG4gICk7XG59XG5cbi8qKiBCYWNrb2ZmIHNjaGVkdWxlIGZvciB0cmFuc2llbnQgbmV0d29yayBlcnJvcnMgKEVDT05OUkVTRVQgZXRjKS4gKi9cbmV4cG9ydCBjb25zdCBORVRXT1JLX1JFVFJZX0RFTEFZU19NUyA9IFsyMDAwLCA2MDAwXTtcblxuZXhwb3J0IGludGVyZmFjZSBQcmludGF2b0NsaWVudE9wdGlvbnMge1xuICBlbWFpbDogc3RyaW5nO1xuICB0b2tlbjogc3RyaW5nO1xuICBlbmRwb2ludD86IHN0cmluZztcbiAgbWluSW50ZXJ2YWxNcz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcmludGF2b0NsaWVudFN0YXRzIHtcbiAgcmVxdWVzdENvdW50OiBudW1iZXI7XG4gIHJldHJ5Q291bnQ6IG51bWJlcjtcbiAgZXJyb3JDb3VudDogbnVtYmVyO1xuICBsYXN0UmVxdWVzdEF0OiBzdHJpbmcgfCBudWxsO1xuICBsYXN0NDI5QXQ6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBjbGFzcyBQcmludGF2b0FwaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcHVibGljIHJlYWRvbmx5IGh0dHBTdGF0dXM/OiBudW1iZXIsXG4gICAgcHVibGljIHJlYWRvbmx5IGdyYXBocWxFcnJvcnM/OiB1bmtub3duW10sXG4gICAgLyoqXG4gICAgICogUGFydGlhbCBgZGF0YWAgcmV0dXJuZWQgYWxvbmdzaWRlIEdyYXBoUUwgZXJyb3JzIChIVFRQIDIwMCkuXG4gICAgICogUHJpbnRhdm8ncyBzY2hlbWEgZGVjbGFyZXMgc29tZSBmaWVsZHMgbm9uLW51bGxhYmxlIHRoYXQgQ0FOIGJlXG4gICAgICogbnVsbCBpbiBwcmFjdGljZSAoZS5nLiBQdXJjaGFzZU9yZGVyLnZlbmRvciBhZnRlciBhIHZlbmRvciBpc1xuICAgICAqIGRlbGV0ZWQpOyBjYWxsZXJzIHRoYXQgY2FuIHRvbGVyYXRlIHRoZSBnYXAgbWF5IHNhbHZhZ2UgdGhpcy5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgcGFydGlhbERhdGE/OiB1bmtub3duLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIlByaW50YXZvQXBpRXJyb3JcIjtcbiAgfVxufVxuXG5pbnRlcmZhY2UgR3JhcGhRTFJlc3BvbnNlPFQ+IHtcbiAgZGF0YT86IFQ7XG4gIGVycm9ycz86IEFycmF5PHsgbWVzc2FnZT86IHN0cmluZyB9Pjtcbn1cblxuaW50ZXJmYWNlIEJ1ZmZlcmVkUmVzcG9uc2Uge1xuICBzdGF0dXM6IG51bWJlcjtcbiAgb2s6IGJvb2xlYW47XG4gIGJvZHlUZXh0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBQcmludGF2b0NsaWVudCB7XG4gIHByaXZhdGUgcmVhZG9ubHkgZ2F0ZTogUmVxdWVzdEdhdGU7XG4gIHByaXZhdGUgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBlbWFpbDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG5cbiAgcHJpdmF0ZSByZXF1ZXN0Q291bnQgPSAwO1xuICBwcml2YXRlIHJldHJ5Q291bnQgPSAwO1xuICBwcml2YXRlIGVycm9yQ291bnQgPSAwO1xuICBwcml2YXRlIGxhc3RSZXF1ZXN0QXQ6IERhdGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBsYXN0NDI5QXQ6IERhdGUgfCBudWxsID0gbnVsbDtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBQcmludGF2b0NsaWVudE9wdGlvbnMpIHtcbiAgICB0aGlzLmVtYWlsID0gb3B0aW9ucy5lbWFpbDtcbiAgICB0aGlzLnRva2VuID0gb3B0aW9ucy50b2tlbjtcbiAgICB0aGlzLmVuZHBvaW50ID0gb3B0aW9ucy5lbmRwb2ludCA/PyBQUklOVEFWT19FTkRQT0lOVDtcbiAgICB0aGlzLmdhdGUgPSBuZXcgUmVxdWVzdEdhdGUob3B0aW9ucy5taW5JbnRlcnZhbE1zID8/IE1JTl9JTlRFUlZBTF9NUyk7XG4gIH1cblxuICBnZXQgc3RhdHMoKTogUHJpbnRhdm9DbGllbnRTdGF0cyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlcXVlc3RDb3VudDogdGhpcy5yZXF1ZXN0Q291bnQsXG4gICAgICByZXRyeUNvdW50OiB0aGlzLnJldHJ5Q291bnQsXG4gICAgICBlcnJvckNvdW50OiB0aGlzLmVycm9yQ291bnQsXG4gICAgICBsYXN0UmVxdWVzdEF0OiB0aGlzLmxhc3RSZXF1ZXN0QXQ/LnRvSVNPU3RyaW5nKCkgPz8gbnVsbCxcbiAgICAgIGxhc3Q0MjlBdDogdGhpcy5sYXN0NDI5QXQ/LnRvSVNPU3RyaW5nKCkgPz8gbnVsbCxcbiAgICB9O1xuICB9XG5cbiAgLyoqIEFsbCBQcmludGF2byB0cmFmZmljIG11c3QgZ28gdGhyb3VnaCB0aGlzIG1ldGhvZC4gKi9cbiAgcXVlcnk8VD4ocXVlcnk6IHN0cmluZywgdmFyaWFibGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9KTogUHJvbWlzZTxUPiB7XG4gICAgcmV0dXJuIHRoaXMuZ2F0ZS5zY2hlZHVsZSgoKSA9PiB0aGlzLmV4ZWN1dGU8VD4ocXVlcnksIHZhcmlhYmxlcywgdHJ1ZSkpO1xuICB9XG5cbiAgLyoqXG4gICAqIEV4ZWN1dGUgYSBub24taWRlbXBvdGVudCBHcmFwaFFMIG11dGF0aW9uIGV4YWN0bHkgb25jZS5cbiAgICpcbiAgICogQSBjb25uZWN0aW9uIGRyb3AgYWZ0ZXIgUHJpbnRhdm8gYWNjZXB0cyBhIG11dGF0aW9uIGNhbiBsb29rIGlkZW50aWNhbCB0b1xuICAgKiBhIGRyb3AgYmVmb3JlIGl0IGFjY2VwdHMgaXQuIFJldHJ5aW5nIGluIGVpdGhlciB0aGlzIGNsaWVudCBvciBhIGNhbGxlclxuICAgKiBjb3VsZCBjcmVhdGUgYSBkdXBsaWNhdGUgcXVvdGUvb3JkZXIsIHNvIHdyaXRlcyBpbnRlbnRpb25hbGx5IGdldCBubyA0MjksXG4gICAqIHRpbWVvdXQsIG9yIG5ldHdvcmsgcmV0cnkuIENhbGxlcnMgbXVzdCBwZXJzaXN0IGFtYmlndW91cyBvdXRjb21lcyBmb3JcbiAgICogb3BlcmF0b3IgcmV2aWV3LlxuICAgKi9cbiAgbXV0YXRlPFQ+KG11dGF0aW9uOiBzdHJpbmcsIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSk6IFByb21pc2U8VD4ge1xuICAgIHJldHVybiB0aGlzLmdhdGUuc2NoZWR1bGUoKCkgPT4gdGhpcy5leGVjdXRlPFQ+KG11dGF0aW9uLCB2YXJpYWJsZXMsIGZhbHNlKSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGV4ZWN1dGU8VD4oXG4gICAgcXVlcnk6IHN0cmluZyxcbiAgICB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIGFsbG93UmV0cnk6IGJvb2xlYW4sXG4gICk6IFByb21pc2U8VD4ge1xuICAgIGZvciAobGV0IHRpbWVvdXRBdHRlbXB0ID0gMDsgOyB0aW1lb3V0QXR0ZW1wdCsrKSB7XG4gICAgICBsZXQgcmVzcG9uc2UgPSBhbGxvd1JldHJ5XG4gICAgICAgID8gYXdhaXQgdGhpcy5wb3N0V2l0aE5ldHdvcmtSZXRyeShxdWVyeSwgdmFyaWFibGVzKVxuICAgICAgICA6IGF3YWl0IHRoaXMucG9zdE9uY2UocXVlcnksIHZhcmlhYmxlcyk7XG5cbiAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xuICAgICAgICBpZiAoIWFsbG93UmV0cnkpIHtcbiAgICAgICAgICB0aGlzLmxhc3Q0MjlBdCA9IG5ldyBEYXRlKCk7XG4gICAgICAgICAgdGhpcy5lcnJvckNvdW50ICs9IDE7XG4gICAgICAgICAgdGhyb3cgbmV3IFByaW50YXZvQXBpRXJyb3IoXG4gICAgICAgICAgICBcIlByaW50YXZvIHJhdGUgbGltaXRlZCBhIG5vbi1pZGVtcG90ZW50IG11dGF0aW9uOyBpdCB3YXMgbm90IHJldHJpZWRcIixcbiAgICAgICAgICAgIDQyOSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMubGFzdDQyOUF0ID0gbmV3IERhdGUoKTtcbiAgICAgICAgdGhpcy5yZXRyeUNvdW50ICs9IDE7XG4gICAgICAgIGF3YWl0IHNsZWVwKFJFVFJZX0FGVEVSXzQyOV9NUyk7XG4gICAgICAgIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5wb3N0V2l0aE5ldHdvcmtSZXRyeShxdWVyeSwgdmFyaWFibGVzKTtcbiAgICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5KSB7XG4gICAgICAgICAgdGhpcy5lcnJvckNvdW50ICs9IDE7XG4gICAgICAgICAgdGhyb3cgbmV3IFByaW50YXZvQXBpRXJyb3IoXG4gICAgICAgICAgICBcIlByaW50YXZvIHJhdGUgbGltaXQgaGl0IHR3aWNlIGluIGEgcm93ICg0MjkgYWZ0ZXIgY29vbGRvd24gcmV0cnkpXCIsXG4gICAgICAgICAgICA0MjksXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgIHRoaXMuZXJyb3JDb3VudCArPSAxO1xuICAgICAgICB0aHJvdyBuZXcgUHJpbnRhdm9BcGlFcnJvcihcbiAgICAgICAgICBgUHJpbnRhdm8gSFRUUCAke3Jlc3BvbnNlLnN0YXR1c306ICR7cmVzcG9uc2UuYm9keVRleHQuc2xpY2UoMCwgNTAwKX1gLFxuICAgICAgICAgIHJlc3BvbnNlLnN0YXR1cyxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbGV0IGJvZHk6IEdyYXBoUUxSZXNwb25zZTxUPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKHJlc3BvbnNlLmJvZHlUZXh0KSBhcyBHcmFwaFFMUmVzcG9uc2U8VD47XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgdGhpcy5lcnJvckNvdW50ICs9IDE7XG4gICAgICAgIHRocm93IG5ldyBQcmludGF2b0FwaUVycm9yKFxuICAgICAgICAgIGBQcmludGF2byByZXR1cm5lZCBpbnZhbGlkIEpTT046ICR7cmVzcG9uc2UuYm9keVRleHQuc2xpY2UoMCwgMjAwKX1gLFxuICAgICAgICAgIHJlc3BvbnNlLnN0YXR1cyxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGJvZHkuZXJyb3JzICYmIGJvZHkuZXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGFsbG93UmV0cnkgJiZcbiAgICAgICAgICBpc1RyYW5zaWVudFRpbWVvdXQoYm9keS5lcnJvcnMpICYmXG4gICAgICAgICAgdGltZW91dEF0dGVtcHQgPCBHUkFQSFFMX1RJTUVPVVRfUkVUUllfREVMQVlTX01TLmxlbmd0aFxuICAgICAgICApIHtcbiAgICAgICAgICB0aGlzLnJldHJ5Q291bnQgKz0gMTtcbiAgICAgICAgICBhd2FpdCBzbGVlcChHUkFQSFFMX1RJTUVPVVRfUkVUUllfREVMQVlTX01TW3RpbWVvdXRBdHRlbXB0XSk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5lcnJvckNvdW50ICs9IDE7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2VzID0gYm9keS5lcnJvcnNcbiAgICAgICAgICAubWFwKChlKSA9PiBlLm1lc3NhZ2UgPz8gSlNPTi5zdHJpbmdpZnkoZSkpXG4gICAgICAgICAgLmpvaW4oXCI7IFwiKTtcbiAgICAgICAgdGhyb3cgbmV3IFByaW50YXZvQXBpRXJyb3IoXG4gICAgICAgICAgYFByaW50YXZvIEdyYXBoUUwgZXJyb3I6ICR7bWVzc2FnZXN9YCxcbiAgICAgICAgICByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgICAgYm9keS5lcnJvcnMsXG4gICAgICAgICAgYm9keS5kYXRhID8/IHVuZGVmaW5lZCxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGJvZHkuZGF0YSA9PT0gdW5kZWZpbmVkIHx8IGJvZHkuZGF0YSA9PT0gbnVsbCkge1xuICAgICAgICB0aGlzLmVycm9yQ291bnQgKz0gMTtcbiAgICAgICAgdGhyb3cgbmV3IFByaW50YXZvQXBpRXJyb3IoXG4gICAgICAgICAgXCJQcmludGF2byByZXR1cm5lZCBubyBkYXRhXCIsXG4gICAgICAgICAgcmVzcG9uc2Uuc3RhdHVzLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gYm9keS5kYXRhO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBmZXRjaCgpIChhbmQgYm9keSBzdHJlYW1pbmcpIHJlamVjdCB3aXRoIFR5cGVFcnJvciAoXCJmZXRjaCBmYWlsZWRcIiAvXG4gICAqIFwidGVybWluYXRlZFwiKSBvbiBjb25uZWN0aW9uLWxldmVsIGZhaWx1cmVzIChFQ09OTlJFU0VULCBETlMgYmxpcHMpLlxuICAgKiBUaGVzZSBhcmUgdHJhbnNpZW50IFx1MjAxNCByZXRyeSB3aXRoIGJhY2tvZmYgaW5zdGVhZCBvZiBmYWlsaW5nIHRoZSB3aG9sZVxuICAgKiBzeW5jIHJ1bi4gVGhlIHJlc3BvbnNlIGJvZHkgaXMgZnVsbHkgYnVmZmVyZWQgSU5TSURFIHRoZSByZXRyaWVkIHVuaXRcbiAgICogYmVjYXVzZSBjb25uZWN0aW9uIGRyb3BzIHN1cmZhY2UgZHVyaW5nIGJvZHkgcmVhZHMgdG9vLCBub3QganVzdCBvblxuICAgKiB0aGUgaW5pdGlhbCBmZXRjaC4gR3JhcGhRTCBxdWVyaWVzIGFyZSByZWFkLW9ubHksIHNvIHJlLXNlbmRpbmcgYWZ0ZXJcbiAgICogYSBwYXJ0aWFsIGV4Y2hhbmdlIGlzIHNhZmUuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHBvc3RXaXRoTmV0d29ya1JldHJ5KFxuICAgIHF1ZXJ5OiBzdHJpbmcsXG4gICAgdmFyaWFibGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgKTogUHJvbWlzZTxCdWZmZXJlZFJlc3BvbnNlPiB7XG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IDsgYXR0ZW1wdCsrKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMucG9zdChxdWVyeSwgdmFyaWFibGVzKTtcbiAgICAgICAgY29uc3QgYm9keVRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgIHJldHVybiB7IHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBvazogcmVzcG9uc2Uub2ssIGJvZHlUZXh0IH07XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGF0dGVtcHQgPj0gTkVUV09SS19SRVRSWV9ERUxBWVNfTVMubGVuZ3RoKSB7XG4gICAgICAgICAgdGhpcy5lcnJvckNvdW50ICs9IDE7XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucmV0cnlDb3VudCArPSAxO1xuICAgICAgICBhd2FpdCBzbGVlcChORVRXT1JLX1JFVFJZX0RFTEFZU19NU1thdHRlbXB0XSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwb3N0T25jZShcbiAgICBxdWVyeTogc3RyaW5nLFxuICAgIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICk6IFByb21pc2U8QnVmZmVyZWRSZXNwb25zZT4ge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5wb3N0KHF1ZXJ5LCB2YXJpYWJsZXMpO1xuICAgIGNvbnN0IGJvZHlUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHJldHVybiB7IHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBvazogcmVzcG9uc2Uub2ssIGJvZHlUZXh0IH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBvc3QoXG4gICAgcXVlcnk6IHN0cmluZyxcbiAgICB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICApOiBQcm9taXNlPFJlc3BvbnNlPiB7XG4gICAgdGhpcy5yZXF1ZXN0Q291bnQgKz0gMTtcbiAgICB0aGlzLmxhc3RSZXF1ZXN0QXQgPSBuZXcgRGF0ZSgpO1xuICAgIHJldHVybiBmZXRjaCh0aGlzLmVuZHBvaW50LCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICAgICAgZW1haWw6IHRoaXMuZW1haWwsXG4gICAgICAgIHRva2VuOiB0aGlzLnRva2VuLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcXVlcnksIHZhcmlhYmxlcyB9KSxcbiAgICB9KTtcbiAgfVxufVxuIiwgIi8qKlxuICogR3JhcGhRTCBxdWVyeSBidWlsZGVycyBmb3IgUHJpbnRhdm8gdjIuXG4gKlxuICogVmFsdWVzIGFyZSBpbmxpbmVkIGFzIGxpdGVyYWxzIChzYWZlbHkgSlNPTi1xdW90ZWQpIGluc3RlYWQgb2YgdHlwZWRcbiAqIHZhcmlhYmxlcyBzbyB3ZSBuZXZlciBoYXZlIHRvIGd1ZXNzIFByaW50YXZvJ3Mgc2NhbGFyL2VudW0gdHlwZSBuYW1lcy5cbiAqXG4gKiBDb25zdHJhaW50cyAodmVyaWZpZWQgdmlhIGxpdmUgc2NoZW1hIGludHJvc3BlY3Rpb24sIEp1bHkgMjAyNik6XG4gKiAtIHBhZ2Ugc2l6ZSBoYXJkLWNhcHBlZCBhdCAyNSByZWdhcmRsZXNzIG9mIGBmaXJzdGBcbiAqIC0gTk8gYHVwZGF0ZWRBZnRlcmAgLyBjaGFuZ2VkLXNpbmNlIGZpbHRlciBleGlzdHMgb24gYW55IGxpc3QgZmllbGRcbiAqIC0gbm8gVVBEQVRFRF9BVCBzb3J0OyBWSVNVQUxfSUQgZGVzYyBpcyB0aGUgcmVjZW5jeSBwcm94eSwgc29cbiAqICAgaW5jcmVtZW50YWwgc3luYyA9IGZ1bGwgcmUtY3Jhd2wgdG8gY3V0b2ZmICsgaGFzaCBkaWZmXG4gKi9cblxuZXhwb3J0IGNvbnN0IFBBR0VfU0laRSA9IDI1O1xuXG5mdW5jdGlvbiBsaXQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIGFmdGVyQXJnKGFmdGVyOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFmdGVyID8gYCwgYWZ0ZXI6ICR7bGl0KGFmdGVyKX1gIDogXCJcIjtcbn1cblxuY29uc3QgQUREUkVTU19GSUVMRFMgPSBgXG4gIGN1c3RvbWVyTmFtZVxuICBjb21wYW55TmFtZVxuICBhZGRyZXNzMVxuICBhZGRyZXNzMlxuICBjaXR5XG4gIHN0YXRlXG4gIHN0YXRlSXNvXG4gIHppcENvZGVcbiAgY291bnRyeVxuYDtcblxuY29uc3QgT1JERVJfTk9ERV9GSUVMRFMgPSBgXG4gIGlkXG4gIHZpc3VhbElkXG4gIG5pY2tuYW1lXG4gIHRvdGFsXG4gIHN1YnRvdGFsXG4gIGFtb3VudFBhaWRcbiAgYW1vdW50T3V0c3RhbmRpbmdcbiAgY3VzdG9tZXJEdWVBdFxuICBpbnZvaWNlQXRcbiAgZHVlQXRcbiAgcGF5bWVudER1ZUF0XG4gIHB1YmxpY1VybFxuICB3b3Jrb3JkZXJVcmxcbiAgY3VzdG9tZXJOb3RlXG4gIHByb2R1Y3Rpb25Ob3RlXG4gIHZpc3VhbFBvTnVtYmVyXG4gIHRhZ3NcbiAgY3JlYXRlZEF0XG4gIHN0YXJ0QXRcbiAgZGlzY291bnRcbiAgZGlzY291bnRBbW91bnRcbiAgZGlzY291bnRBc1BlcmNlbnRhZ2VcbiAgc2FsZXNUYXhcbiAgc2FsZXNUYXhBbW91bnRcbiAgdG90YWxVbnRheGVkXG4gIHRvdGFsUXVhbnRpdHlcbiAgcGFpZEluRnVsbFxuICBtZXJjaFxuICBwYWNraW5nU2xpcFVybFxuICBwdWJsaWNQZGZcbiAgcHVibGljSGFzaFxuICB1cmxcbiAgc3RhdHVzIHsgaWQgbmFtZSB9XG4gIG93bmVyIHsgaWQgZW1haWwgfVxuICBjb250YWN0IHsgaWQgZnVsbE5hbWUgZW1haWwgY3VzdG9tZXIgeyBpZCBjb21wYW55TmFtZSB9IH1cbiAgc2hpcHBpbmdBZGRyZXNzIHsgJHtBRERSRVNTX0ZJRUxEU30gfVxuICBiaWxsaW5nQWRkcmVzcyB7ICR7QUREUkVTU19GSUVMRFN9IH1cbiAgZGVsaXZlcnlNZXRob2QgeyBpZCBuYW1lIGFyY2hpdmVkIH1cbiAgcGF5bWVudFRlcm0geyBpZCBuYW1lIGRheXMgYXJjaGl2ZWQgfVxuICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG5gO1xuXG5jb25zdCBQQUdFX0lORk8gPSBgcGFnZUluZm8geyBoYXNOZXh0UGFnZSBlbmRDdXJzb3IgfWA7XG5cbmV4cG9ydCBpbnRlcmZhY2UgT3JkZXJQYWdlQXJncyB7XG4gIGFmdGVyPzogc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIFJlc3RyaWN0IHRoZSBsaXN0IGF0IFByaW50YXZvIGJlZm9yZSBwYWdpbmF0aW9uLiBUaGUgdjIgc2NoZW1hIGFjY2VwdHNcbiAgICogYHN0YXR1c0lkczogW0lEIV1gIG9uIGJvdGggaW52b2ljZXMgYW5kIHF1b3RlcyAodmVyaWZpZWQgYnkgbGl2ZVxuICAgKiBpbnRyb3NwZWN0aW9uKS4gQXV0by1wcmludCB1c2VzIHRoaXMgaW5zdGVhZCBvZiBjcmF3bGluZyB0aGUgY29tcGxldGVcbiAgICogb3JkZXIgaGlzdG9yeSBhbmQgZmlsdGVyaW5nIGEgc3RhbGUgbG9jYWwgbWlycm9yLlxuICAgKi9cbiAgc3RhdHVzSWRzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBWSVNVQUxfSUQgc29ydCBkaXJlY3Rpb24uIERlZmF1bHQgdHJ1ZSAobmV3ZXN0LWZpcnN0KSBcdTIwMTQgdGhlXG4gICAqIGluY3JlbWVudGFsIGNyYXdsJ3MgcmVjZW5jeSBwcm94eS4gSGlzdG9yeSBiYWNrZmlsbCBwYXNzZXMgZmFsc2VcbiAgICogdG8gd2FsayB0aGUgYXJjaGl2ZSBvbGRlc3QtZmlyc3QgKHZlcmlmaWVkIGxpdmU6IGFzY2VuZGluZyBzb3J0XG4gICAqIHdvcmtzOyBub3RlIHZpc3VhbCBpZHMgYXJlIE5PVCBkYXRlLW9yZGVyZWQsIGUuZy4gaW52b2ljZSAjMTAwMFxuICAgKiB3YXMgY3JlYXRlZCBpbiAyMDIxKS5cbiAgICovXG4gIHNvcnREZXNjZW5kaW5nPzogYm9vbGVhbjtcbn1cblxuZnVuY3Rpb24gc29ydERlc2NBcmcoc29ydERlc2NlbmRpbmc6IGJvb2xlYW4gfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICByZXR1cm4gc29ydERlc2NlbmRpbmcgPT09IGZhbHNlID8gXCJmYWxzZVwiIDogXCJ0cnVlXCI7XG59XG5cbmZ1bmN0aW9uIHN0YXR1c0lkc0FyZyhzdGF0dXNJZHM6IHJlYWRvbmx5IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgaWYgKCFzdGF0dXNJZHMgfHwgc3RhdHVzSWRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG4gIHJldHVybiBgLCBzdGF0dXNJZHM6IFske3N0YXR1c0lkcy5tYXAobGl0KS5qb2luKFwiLCBcIil9XWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnZvaWNlc1BhZ2VRdWVyeShhcmdzOiBPcmRlclBhZ2VBcmdzID0ge30pOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBpbnZvaWNlcyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhcmdzLmFmdGVyKX0ke3N0YXR1c0lkc0FyZyhhcmdzLnN0YXR1c0lkcyl9LCBzb3J0T246IFZJU1VBTF9JRCwgc29ydERlc2NlbmRpbmc6ICR7c29ydERlc2NBcmcoYXJncy5zb3J0RGVzY2VuZGluZyl9KSB7XG4gICAgICBub2RlcyB7ICR7T1JERVJfTk9ERV9GSUVMRFN9IH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBxdW90ZXNQYWdlUXVlcnkoYXJnczogT3JkZXJQYWdlQXJncyA9IHt9KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgcXVvdGVzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFyZ3MuYWZ0ZXIpfSR7c3RhdHVzSWRzQXJnKGFyZ3Muc3RhdHVzSWRzKX0sIHNvcnRPbjogVklTVUFMX0lELCBzb3J0RGVzY2VuZGluZzogJHtzb3J0RGVzY0FyZyhhcmdzLnNvcnREZXNjZW5kaW5nKX0pIHtcbiAgICAgIG5vZGVzIHsgJHtPUkRFUl9OT0RFX0ZJRUxEU30gfVxuICAgICAgJHtQQUdFX0lORk99XG4gICAgfVxuICB9YDtcbn1cblxuLyoqXG4gKiBPcmRlci1saXN0IHRvdGFsczogaGlzdG9yeS1iYWNrZmlsbCBwcm9ncmVzcyBkZW5vbWluYXRvciArIGZpbmFsXG4gKiBnYXAgdmVyaWZpY2F0aW9uIChEQiByb3cgY291bnQgdnMgUHJpbnRhdm8ncyB0b3RhbE5vZGVzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyVG90YWxzUXVlcnkoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgaW52b2ljZXMoZmlyc3Q6IDEpIHsgdG90YWxOb2RlcyB9XG4gICAgcXVvdGVzKGZpcnN0OiAxKSB7IHRvdGFsTm9kZXMgfVxuICB9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGN1c3RvbWVyc1BhZ2VRdWVyeShhZnRlcj86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBjdXN0b21lcnMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgbm9kZXMge1xuICAgICAgICBpZFxuICAgICAgICBjb21wYW55TmFtZVxuICAgICAgICBvd25lciB7IGlkIGVtYWlsIH1cbiAgICAgICAgcHJpbWFyeUNvbnRhY3QgeyBpZCBmdWxsTmFtZSBlbWFpbCB9XG4gICAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICAgIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb250YWN0c1BhZ2VRdWVyeShhZnRlcj86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBjb250YWN0cyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhZnRlcil9KSB7XG4gICAgICBub2RlcyB7XG4gICAgICAgIGlkXG4gICAgICAgIGZ1bGxOYW1lXG4gICAgICAgIGVtYWlsXG4gICAgICAgIHBob25lXG4gICAgICAgIGN1c3RvbWVyIHsgaWQgY29tcGFueU5hbWUgfVxuICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3RhdHVzZXNQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgc3RhdHVzZXMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgbm9kZXMgeyBpZCBuYW1lIGNvbG9yIHBvc2l0aW9uIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qKiBDaGVhcGVzdCBwb3NzaWJsZSBhdXRoZW50aWNhdGVkIHJlcXVlc3QgXHUyMDE0IHByb3ZlcyBjcmVkcyArIGNvbm5lY3Rpdml0eS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9iZVF1ZXJ5KCk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkgeyBzdGF0dXNlcyhmaXJzdDogMSkgeyBub2RlcyB7IGlkIG5hbWUgfSB9IH1gO1xufVxuXG4vKlxuICogXHUyNTAwXHUyNTAwIE9yZGVyIGRldGFpbCAobGluZSBpdGVtcyAvIGltcHJpbnRzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIENvbXBsZXhpdHkgY2FwIGlzIDI1LDAwMC4gVGhlIG5lc3RlZCBsaXN0IGNyYXdsIGZpdHMgYXQgOCBvcmRlcnMvcGFnZVxuICogd2l0aCB0aGUgc2xpbSBmaWVsZCBzZXQgYmVsb3cgKHByb2JlZCBsaXZlIEp1bHkgMjAyNik7IHRoZSBzaW5nbGUtb3JkZXJcbiAqIHF1ZXJ5IHVzZXMgZ2VuZXJvdXMgbGltaXRzIGZvciB0b3BwaW5nIHVwIHRydW5jYXRlZCBjb25uZWN0aW9ucy5cbiAqL1xuXG4vKiogT3JkZXJzIHBlciBwYWdlIGZvciB0aGUgbmVzdGVkIGRldGFpbCBjcmF3bCAoY29tcGxleGl0eS1saW1pdGVkOiA2IFx1MjI0OCAyMmsgb2YgdGhlIDI1ayBjYXA7IDcgPSAyNSw3MjMgcmVqZWN0ZWQpLiAqL1xuZXhwb3J0IGNvbnN0IERFVEFJTF9QQUdFX1NJWkUgPSA2O1xuY29uc3QgREVUQUlMX0dST1VQU19GSVJTVCA9IDg7XG5jb25zdCBERVRBSUxfTElORV9JVEVNU19GSVJTVCA9IDIwO1xuY29uc3QgREVUQUlMX0lNUFJJTlRTX0ZJUlNUID0gODtcblxuY29uc3QgTElORV9JVEVNX0ZJRUxEUyA9IGBcbiAgaWRcbiAgaXRlbU51bWJlclxuICBjb2xvclxuICBkZXNjcmlwdGlvblxuICBpdGVtc1xuICBwcmljZVxuICBtZXJjaFxuICBwcm9kdWN0U3RhdHVzXG4gIHNpemVzIHsgc2l6ZSBjb3VudCB9XG4gIGNhdGVnb3J5IHsgaWQgbmFtZSB9XG4gIHByb2R1Y3QgeyBpZCBicmFuZCB9XG5gO1xuXG5jb25zdCBJTVBSSU5UX0ZJRUxEUyA9IGBcbiAgaWRcbiAgZGV0YWlsc1xuICBwcmljaW5nTWF0cml4Q29sdW1uIHsgaWQgY29sdW1uTmFtZSBtYXRyaXggeyBpZCBuYW1lIH0gfVxuICB0eXBlT2ZXb3JrIHsgaWQgbmFtZSB9XG5gO1xuXG5mdW5jdGlvbiBsaW5lSXRlbUdyb3Vwc1NlbGVjdGlvbihcbiAgZ3JvdXBzRmlyc3Q6IG51bWJlcixcbiAgbGluZUl0ZW1zRmlyc3Q6IG51bWJlcixcbiAgaW1wcmludHNGaXJzdDogbnVtYmVyLFxuICBvcHRzPzogeyB3aXRoR3JvdXBDdXJzb3I/OiBib29sZWFuOyBhZnRlcj86IHN0cmluZyB8IG51bGwgfSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGdyb3VwUGFnZUluZm8gPSBvcHRzPy53aXRoR3JvdXBDdXJzb3JcbiAgICA/IGBwYWdlSW5mbyB7IGhhc05leHRQYWdlIGVuZEN1cnNvciB9YFxuICAgIDogYHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfWA7XG4gIHJldHVybiBgbGluZUl0ZW1Hcm91cHMoZmlyc3Q6ICR7Z3JvdXBzRmlyc3R9JHthZnRlckFyZyhvcHRzPy5hZnRlcil9KSB7XG4gICAgbm9kZXMge1xuICAgICAgaWRcbiAgICAgIHBvc2l0aW9uXG4gICAgICBsaW5lSXRlbXMoZmlyc3Q6ICR7bGluZUl0ZW1zRmlyc3R9KSB7XG4gICAgICAgIG5vZGVzIHsgJHtMSU5FX0lURU1fRklFTERTfSB9XG4gICAgICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICAgICAgfVxuICAgICAgaW1wcmludHMoZmlyc3Q6ICR7aW1wcmludHNGaXJzdH0pIHtcbiAgICAgICAgbm9kZXMgeyAke0lNUFJJTlRfRklFTERTfSB9XG4gICAgICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICAgICAgfVxuICAgIH1cbiAgICAke2dyb3VwUGFnZUluZm99XG4gIH1gO1xufVxuXG5leHBvcnQgdHlwZSBPcmRlcktpbmQgPSBcImludm9pY2VzXCIgfCBcInF1b3Rlc1wiO1xuXG4vKipcbiAqIE5lc3RlZCBkZXRhaWwgY3Jhd2wgcGFnZTogb3JkZXJzIChWSVNVQUxfSUQgZGVzYykgd2l0aCBsaW5lIGl0ZW0gZ3JvdXBzLFxuICogbGluZSBpdGVtcywgYW5kIGltcHJpbnRzIGlubGluZS4gVHJ1bmNhdGlvbiBkZXRlY3RhYmxlIHZpYSB0aGUgbmVzdGVkXG4gKiBwYWdlSW5mby5oYXNOZXh0UGFnZSBmbGFncyBcdTIwMTQgdG9wIHVwIHdpdGggc2luZ2xlT3JkZXJEZXRhaWxRdWVyeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyRGV0YWlsUGFnZVF1ZXJ5KFxuICBraW5kOiBPcmRlcktpbmQsXG4gIGFmdGVyPzogc3RyaW5nIHwgbnVsbCxcbiAgb3B0czogeyBzb3J0RGVzY2VuZGluZz86IGJvb2xlYW4gfSA9IHt9LFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgJHtraW5kfShmaXJzdDogJHtERVRBSUxfUEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSwgc29ydE9uOiBWSVNVQUxfSUQsIHNvcnREZXNjZW5kaW5nOiAke3NvcnREZXNjQXJnKG9wdHMuc29ydERlc2NlbmRpbmcpfSkge1xuICAgICAgbm9kZXMge1xuICAgICAgICBpZFxuICAgICAgICB2aXN1YWxJZFxuICAgICAgICB0b3RhbFF1YW50aXR5XG4gICAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICAgICAgJHtsaW5lSXRlbUdyb3Vwc1NlbGVjdGlvbihERVRBSUxfR1JPVVBTX0ZJUlNULCBERVRBSUxfTElORV9JVEVNU19GSVJTVCwgREVUQUlMX0lNUFJJTlRTX0ZJUlNUKX1cbiAgICAgIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qKlxuICogU2luZ2xlLW9yZGVyIGRldGFpbCB3aXRoIGdlbmVyb3VzIGxpbWl0cyAodG9wLXVwIGZvciB0cnVuY2F0ZWQgb3JkZXJzKS5cbiAqIDIwLzQwLzE1IHByb2JlZCBPSyBKdWx5IDIwMjY7IDI1LzUwLzI1ID0gY29tcGxleGl0eSAyOSw2MzYgPiAyNWsgY2FwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2luZ2xlT3JkZXJEZXRhaWxRdWVyeShcbiAga2luZDogXCJpbnZvaWNlXCIgfCBcInF1b3RlXCIsXG4gIHByaW50YXZvSWQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgICR7a2luZH0oaWQ6ICR7bGl0KHByaW50YXZvSWQpfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICB0b3RhbFF1YW50aXR5XG4gICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICAke2xpbmVJdGVtR3JvdXBzU2VsZWN0aW9uKDIwLCA0MCwgMTUsIHsgd2l0aEdyb3VwQ3Vyc29yOiB0cnVlIH0pfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qKiBFeGFjdC1vcmRlciBzdGF0dXMgZmVuY2UgdXNlZCBpbW1lZGlhdGVseSBiZWZvcmUgUHJpbnROb2RlL3N0YXR1cyB3cml0ZXMuICovXG5leHBvcnQgZnVuY3Rpb24gc2luZ2xlT3JkZXJTdGF0dXNRdWVyeShcbiAga2luZDogXCJpbnZvaWNlXCIgfCBcInF1b3RlXCIsXG4gIHByaW50YXZvSWQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgICR7a2luZH0oaWQ6ICR7bGl0KHByaW50YXZvSWQpfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICBzdGF0dXMgeyBpZCBuYW1lIH1cbiAgICB9XG4gIH1gO1xufVxuXG4vKipcbiAqIEZvbGxvdy11cCBwYWdlIG9mIGxpbmVJdGVtR3JvdXBzIGZvciBvcmRlcnMgd2l0aCBtb3JlIGdyb3VwcyB0aGFuIHRoZVxuICogc2luZ2xlLW9yZGVyIHF1ZXJ5J3MgZmlyc3QgcGFnZSAodGhlID4yNS1ncm91cCB0cnVuY2F0aW9uIGZpeCkuIFNhbWVcbiAqIGdlbmVyb3VzIG5lc3RlZCBsaW1pdHM7IGN1cnNvciBjb250aW51ZXMgZnJvbSB0aGUgcHJldmlvdXMgcGFnZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyR3JvdXBzUGFnZVF1ZXJ5KFxuICBraW5kOiBcImludm9pY2VcIiB8IFwicXVvdGVcIixcbiAgcHJpbnRhdm9JZDogc3RyaW5nLFxuICBhZnRlcjogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgJHtraW5kfShpZDogJHtsaXQocHJpbnRhdm9JZCl9KSB7XG4gICAgICBpZFxuICAgICAgJHtsaW5lSXRlbUdyb3Vwc1NlbGVjdGlvbigxMCwgNDAsIDE1LCB7IHdpdGhHcm91cEN1cnNvcjogdHJ1ZSwgYWZ0ZXIgfSl9XG4gICAgfVxuICB9YDtcbn1cblxuLypcbiAqIFx1MjUwMFx1MjUwMCBQcm9kdWN0LXN0YXR1cyBzd2VlcCAoc2xpbSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gKiBQcmludGF2byBkb2VzIE5PVCBidW1wIGFuIG9yZGVyJ3MgdXBkYXRlZEF0IHdoZW4gYSBsaW5lIGl0ZW0nc1xuICogcHJvZHVjdFN0YXR1cyBjaGFuZ2VzICh2ZXJpZmllZCBsaXZlIEp1bHkgMjAyNiksIHNvIHRoZSBoYXNoLWJhc2VkIGxpc3RcbiAqIGNyYXdsIG5ldmVyIG5vdGljZXMuIFRoaXMgc2xpbSBwYWdlIGZldGNoZXMgT05MWSBsaW5lIGl0ZW0gaWQgK1xuICogcHJvZHVjdFN0YXR1cyBzbyB0aGUgc3luYyBjYW4gZGlmZiBhZ2FpbnN0IHRoZSBEQiBhbmQgcmUtcHVsbCBkZXRhaWxzXG4gKiBmb3IgbWlzbWF0Y2hlZCBvcmRlcnMuIE5lc3RpbmcgbGltaXRzICgyNSBpbnZvaWNlcyBcdTAwRDcgNSBncm91cHMgXHUwMEQ3IDggaXRlbXMpXG4gKiBhcmUgdGhlIGxlZ2FjeSBQTyBCdWlsZGVyJ3MgcHJvdmVuLXNhZmUgY29tcGxleGl0eSBidWRnZXQgXHUyMDE0IGRvIE5PVCByYWlzZS5cbiAqL1xuXG5jb25zdCBTV0VFUF9HUk9VUFNfRklSU1QgPSA1O1xuY29uc3QgU1dFRVBfTElORV9JVEVNU19GSVJTVCA9IDg7XG5cbmV4cG9ydCBmdW5jdGlvbiBwcm9kdWN0U3RhdHVzU3dlZXBQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgaW52b2ljZXMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSwgc29ydE9uOiBWSVNVQUxfSUQsIHNvcnREZXNjZW5kaW5nOiB0cnVlKSB7XG4gICAgICBub2RlcyB7XG4gICAgICAgIGlkXG4gICAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICAgICAgbGluZUl0ZW1Hcm91cHMoZmlyc3Q6ICR7U1dFRVBfR1JPVVBTX0ZJUlNUfSkge1xuICAgICAgICAgIG5vZGVzIHtcbiAgICAgICAgICAgIGlkXG4gICAgICAgICAgICBsaW5lSXRlbXMoZmlyc3Q6ICR7U1dFRVBfTElORV9JVEVNU19GSVJTVH0pIHtcbiAgICAgICAgICAgICAgbm9kZXMgeyBpZCBwcm9kdWN0U3RhdHVzIH1cbiAgICAgICAgICAgICAgcGFnZUluZm8geyBoYXNOZXh0UGFnZSB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG4vKlxuICogXHUyNTAwXHUyNTAwIFBPIHB1c2ggd3JpdGUgbXV0YXRpb25zIChQM2MpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogVmVyaWZpZWQgdmlhIGxpdmUgaW50cm9zcGVjdGlvbiBKdWx5IDIwMjY6XG4gKiAtIGxpbmVJdGVtVXBkYXRlKGlkOiBJRCEsIGlucHV0OiBMaW5lSXRlbUlucHV0ISkgXHUyMDE0IHBvc2l0aW9uIGlzIFJFUVVJUkVEXG4gKiAgIGluIHRoZSBpbnB1dCBvciB0aGUgbXV0YXRpb24gZmFpbHM7IHByb2R1Y3RTdGF0dXMgaXMgdGhlIExpbmVJdGVtU3RhdHVzXG4gKiAgIGVudW0gKG5lZWRfb3JkZXJpbmcsIGF0dGFjaGVkX3RvX3BvLCBvcmRlcmVkLCBhcnJpdmVkLFxuICogICBwYXJ0aWFsbHlfcmVjZWl2ZWQsIHJlY2VpdmVkLCBpbik7IHNpemVzIGlzIFtMaW5lSXRlbVNpemVDb3VudElucHV0IV1cbiAqICAgd2l0aCBzaXplIGJlaW5nIHRoZSBMaW5lSXRlbVNpemUgZW51bSAoc2l6ZV9zIFx1MjAyNiBzaXplXzV0KS5cbiAqIC0gcHJvZHVjdGlvbkZpbGVDcmVhdGUocGFyZW50SWQ6IElEISwgcHVibGljRmlsZVVybDogU3RyaW5nISkgXHUyMDE0IFByaW50YXZvXG4gKiAgIGZldGNoZXMgdGhlIGZpbGUgZnJvbSB0aGUgVVJMIGFzeW5jaHJvbm91c2x5IGFmdGVyIHRoZSBtdXRhdGlvbi5cbiAqL1xuXG4vKiogTGluZUl0ZW1TaXplIGVudW0gdmFsdWVzIGFjY2VwdGVkIGJ5IGxpbmVJdGVtVXBkYXRlIChpbnRyb3NwZWN0ZWQgbGl2ZSkuICovXG5leHBvcnQgY29uc3QgUFJJTlRBVk9fU0laRV9FTlVNID0gbmV3IFNldChbXG4gIFwic2l6ZV95eHNcIiwgXCJzaXplX3lzXCIsIFwic2l6ZV95bVwiLCBcInNpemVfeWxcIiwgXCJzaXplX3l4bFwiLFxuICBcInNpemVfeHNcIiwgXCJzaXplX3NcIiwgXCJzaXplX21cIiwgXCJzaXplX2xcIiwgXCJzaXplX3hsXCIsXG4gIFwic2l6ZV8yeGxcIiwgXCJzaXplXzN4bFwiLCBcInNpemVfNHhsXCIsIFwic2l6ZV81eGxcIiwgXCJzaXplXzZ4bFwiLFxuICBcInNpemVfb3RoZXJcIixcbiAgXCJzaXplXzZtXCIsIFwic2l6ZV8xMm1cIiwgXCJzaXplXzE4bVwiLCBcInNpemVfMjRtXCIsXG4gIFwic2l6ZV8ydFwiLCBcInNpemVfM3RcIiwgXCJzaXplXzR0XCIsIFwic2l6ZV81dFwiLFxuXSk7XG5cbi8qKlxuICogTWFwIGEgSHViLW5vcm1hbGl6ZWQgc2l6ZSBsYWJlbCAoc3RyaXBwZWQgYHNpemVfYCBwcmVmaXgsIHVwcGVyY2FzZWQgXHUyMDE0XG4gKiBlLmcuIFwiTVwiLCBcIjJYTFwiLCBcIjZNXCIpIGJhY2sgdG8gUHJpbnRhdm8ncyBMaW5lSXRlbVNpemUgZW51bS4gUmV0dXJucyBudWxsXG4gKiBmb3IgYW55dGhpbmcgdGhhdCBkb2VzIG5vdCBtYXAgZXhhY3RseSAoZS5nLiB0aGUgc3ludGhldGljIFwiT1NGQVwiIHJvd3MgdGhlXG4gKiBjYXJ0IGFkZHMgZm9yIHNpemUtbGVzcyBsaW5lcykgXHUyMDE0IGNhbGxlcnMgbXVzdCB0aGVuIGxlYXZlIHNpemVzIHVudG91Y2hlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvTGluZUl0ZW1TaXplRW51bShsYWJlbDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IGBzaXplXyR7bGFiZWwudHJpbSgpLnRvTG93ZXJDYXNlKCl9YDtcbiAgcmV0dXJuIFBSSU5UQVZPX1NJWkVfRU5VTS5oYXMoY2FuZGlkYXRlKSA/IGNhbmRpZGF0ZSA6IG51bGw7XG59XG5cbi8qKiBMaW5lIGl0ZW0gc3RhdHVzZXMgdGhhdCBtZWFuIFwidGhlIGdvb2RzIGFyZSBhbHJlYWR5IG9yZGVyZWQvaGVyZVwiIFx1MjAxNCBhIHB1c2ggbXVzdCBza2lwIHRoZXNlLiAqL1xuZXhwb3J0IGNvbnN0IE9SREVSRURfT1JfTEFURVJfU1RBVFVTRVMgPSBuZXcgU2V0KFtcbiAgXCJvcmRlcmVkXCIsXG4gIFwiYXJyaXZlZFwiLFxuICBcInBhcnRpYWxseV9yZWNlaXZlZFwiLFxuICBcInJlY2VpdmVkXCIsXG5dKTtcblxuLyoqIFNsaW0gc2luZ2xlIGxpbmUgaXRlbSBmZXRjaCB1c2VkIGJ5IHRoZSBQTyBwdXNoIHRvIGRpZmYgYmVmb3JlIHdyaXRpbmcuICovXG5leHBvcnQgZnVuY3Rpb24gcG9QdXNoTGluZUl0ZW1RdWVyeShsaW5lSXRlbUlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBsaW5lSXRlbShpZDogJHtsaXQobGluZUl0ZW1JZCl9KSB7XG4gICAgICBpZFxuICAgICAgcG9zaXRpb25cbiAgICAgIHByb2R1Y3RTdGF0dXNcbiAgICAgIGl0ZW1OdW1iZXJcbiAgICAgIGNvbG9yXG4gICAgICBzaXplcyB7IHNpemUgY291bnQgfVxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGluZUl0ZW1VcGRhdGVJbnB1dCB7XG4gIC8qKiBSRVFVSVJFRCBieSBQcmludGF2bydzIExpbmVJdGVtSW5wdXQuICovXG4gIHBvc2l0aW9uOiBudW1iZXI7XG4gIC8qKlxuICAgKiBMaW5lSXRlbVN0YXR1cyBlbnVtIHZhbHVlLCBlLmcuIFwib3JkZXJlZFwiICh1bnF1b3RlZCBlbnVtIGxpdGVyYWwpLlxuICAgKiBgbnVsbGAgZXhwbGljaXRseSBjbGVhcnMgdGhlIHN0YXR1czsgYHVuZGVmaW5lZGAgbGVhdmVzIGl0IHVudG91Y2hlZC5cbiAgICovXG4gIHByb2R1Y3RTdGF0dXM/OiBzdHJpbmcgfCBudWxsO1xuICBpdGVtTnVtYmVyPzogc3RyaW5nO1xuICBjb2xvcj86IHN0cmluZztcbiAgLyoqIFBhaXJzIG9mIChMaW5lSXRlbVNpemUgZW51bSB2YWx1ZSwgY291bnQpLiBFbnVtIHZhbHVlcyBtdXN0IGNvbWUgZnJvbSBQUklOVEFWT19TSVpFX0VOVU0uICovXG4gIHNpemVzPzogQXJyYXk8eyBzaXplOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfT47XG59XG5cbmNvbnN0IEVOVU1fTElURVJBTCA9IC9eW2Etel9dW2EtejAtOV9dKiQvO1xuXG5mdW5jdGlvbiBlbnVtTGl0KHZhbHVlOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghRU5VTV9MSVRFUkFMLnRlc3QodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkICR7d2hhdH0gZW51bSB2YWx1ZTogJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9YCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbGluZUl0ZW1VcGRhdGVNdXRhdGlvbihcbiAgbGluZUl0ZW1JZDogc3RyaW5nLFxuICBpbnB1dDogTGluZUl0ZW1VcGRhdGVJbnB1dCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtgcG9zaXRpb246ICR7TWF0aC50cnVuYyhpbnB1dC5wb3NpdGlvbil9YF07XG4gIGlmIChpbnB1dC5wcm9kdWN0U3RhdHVzICE9PSB1bmRlZmluZWQpIHtcbiAgICBwYXJ0cy5wdXNoKFxuICAgICAgaW5wdXQucHJvZHVjdFN0YXR1cyA9PT0gbnVsbFxuICAgICAgICA/IFwicHJvZHVjdFN0YXR1czogbnVsbFwiXG4gICAgICAgIDogYHByb2R1Y3RTdGF0dXM6ICR7ZW51bUxpdChpbnB1dC5wcm9kdWN0U3RhdHVzLCBcIkxpbmVJdGVtU3RhdHVzXCIpfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoaW5wdXQuaXRlbU51bWJlciAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGBpdGVtTnVtYmVyOiAke2xpdChpbnB1dC5pdGVtTnVtYmVyKX1gKTtcbiAgaWYgKGlucHV0LmNvbG9yICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYGNvbG9yOiAke2xpdChpbnB1dC5jb2xvcil9YCk7XG4gIGlmIChpbnB1dC5zaXplcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3Qgc2l6ZUxpdHMgPSBpbnB1dC5zaXplcy5tYXAoXG4gICAgICAocykgPT4gYHsgc2l6ZTogJHtlbnVtTGl0KHMuc2l6ZSwgXCJMaW5lSXRlbVNpemVcIil9LCBjb3VudDogJHtNYXRoLnRydW5jKHMuY291bnQpfSB9YCxcbiAgICApO1xuICAgIHBhcnRzLnB1c2goYHNpemVzOiBbJHtzaXplTGl0cy5qb2luKFwiLCBcIil9XWApO1xuICB9XG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIGxpbmVJdGVtVXBkYXRlKGlkOiAke2xpdChsaW5lSXRlbUlkKX0sIGlucHV0OiB7ICR7cGFydHMuam9pbihcIiwgXCIpfSB9KSB7XG4gICAgICBpZFxuICAgICAgcHJvZHVjdFN0YXR1c1xuICAgIH1cbiAgfWA7XG59XG5cbi8qKlxuICogUmVhZCBjdXJyZW50IGdyb3VwIHBvc2l0aW9ucyBiZWZvcmUgYXBwZW5kaW5nIGEgY2FsY3VsYXRvci1jcmVhdGVkIGdyb3VwLlxuICogQm90aCBRdW90ZSBhbmQgSW52b2ljZSBleHBvc2UgbGluZUl0ZW1Hcm91cHM7IGFsaWFzIHRoZSBzZWxlY3RlZCByb290IHRvIGFcbiAqIHN0YWJsZSByZXNwb25zZSBrZXkgc28gY2FsbGVycyBuZXZlciBuZWVkIHRvIHRydXN0IGEgY2xpZW50LXN1cHBsaWVkIHR5cGUuXG4gKiBUaGUgY2FsbGVyIGZhaWxzIGNsb3NlZCBpZiBQcmludGF2byByZXBvcnRzIG1vcmUgdGhhbiAxMDAgZ3JvdXBzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJMaW5lSXRlbUdyb3VwUG9zaXRpb25zUXVlcnkoXG4gIG9yZGVySWQ6IHN0cmluZyxcbiAgb3JkZXJUeXBlOiBcImludm9pY2VcIiB8IFwicXVvdGVcIixcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIG9yZGVyOiAke29yZGVyVHlwZX0oaWQ6ICR7bGl0KG9yZGVySWQpfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICBsaW5lSXRlbUdyb3VwcyhmaXJzdDogMTAwKSB7XG4gICAgICAgIG5vZGVzIHsgaWQgcG9zaXRpb24gfVxuICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgIH1cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENhbGN1bGF0b3JMaW5lSXRlbUNyZWF0ZUlucHV0IHtcbiAgcG9zaXRpb246IG51bWJlcjtcbiAgY2F0ZWdvcnlJZDogc3RyaW5nO1xuICBpdGVtTnVtYmVyOiBzdHJpbmc7XG4gIGNvbG9yOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQXBwZW5kcyBvbmUgbmV3IGxpbmUtaXRlbSBncm91cCBjb250YWluaW5nIG9uZSBxdW90ZWQgZ2FybWVudC5cbiAqIFNoYXBlIHZlcmlmaWVkIHRocm91Z2ggbGl2ZSBQcmludGF2byBzY2hlbWEgaW50cm9zcGVjdGlvbiBBdWd1c3QgMjAyNjpcbiAqIGxpbmVJdGVtR3JvdXBDcmVhdGUocGFyZW50SWQ6IElEISwgaW5wdXQ6IExpbmVJdGVtR3JvdXBDcmVhdGVJbnB1dCEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2FsY3VsYXRvckxpbmVJdGVtR3JvdXBDcmVhdGVNdXRhdGlvbihcbiAgcGFyZW50SWQ6IHN0cmluZyxcbiAgaW5wdXQ6IENhbGN1bGF0b3JMaW5lSXRlbUNyZWF0ZUlucHV0LFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBtdXRhdGlvbiB7XG4gICAgbGluZUl0ZW1Hcm91cENyZWF0ZShcbiAgICAgIHBhcmVudElkOiAke2xpdChwYXJlbnRJZCl9XG4gICAgICBpbnB1dDoge1xuICAgICAgICBwb3NpdGlvbjogJHtNYXRoLnRydW5jKGlucHV0LnBvc2l0aW9uKX1cbiAgICAgICAgbGluZUl0ZW1zOiBbe1xuICAgICAgICAgIHBvc2l0aW9uOiAwXG4gICAgICAgICAgY2F0ZWdvcnk6IHsgaWQ6ICR7bGl0KGlucHV0LmNhdGVnb3J5SWQpfSB9XG4gICAgICAgICAgaXRlbU51bWJlcjogJHtsaXQoaW5wdXQuaXRlbU51bWJlcil9XG4gICAgICAgICAgY29sb3I6ICR7bGl0KGlucHV0LmNvbG9yKX1cbiAgICAgICAgICBkZXNjcmlwdGlvbjogJHtsaXQoaW5wdXQuZGVzY3JpcHRpb24pfVxuICAgICAgICAgIHByb2R1Y3RTdGF0dXM6IG5lZWRfb3JkZXJpbmdcbiAgICAgICAgICB0YXhlZDogdHJ1ZVxuICAgICAgICB9XVxuICAgICAgfVxuICAgICkge1xuICAgICAgaWRcbiAgICAgIHBvc2l0aW9uXG4gICAgICBsaW5lSXRlbXMoZmlyc3Q6IDEwKSB7XG4gICAgICAgIG5vZGVzIHtcbiAgICAgICAgICBpZFxuICAgICAgICAgIGl0ZW1OdW1iZXJcbiAgICAgICAgICBjb2xvclxuICAgICAgICAgIGRlc2NyaXB0aW9uXG4gICAgICAgICAgY2F0ZWdvcnkgeyBpZCBuYW1lIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUXVvdGVDcmVhdGVMaW5lSXRlbSB7XG4gIHBvc2l0aW9uOiBudW1iZXI7XG4gIGl0ZW1OdW1iZXI6IHN0cmluZztcbiAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgY29sb3I6IHN0cmluZztcbiAgcHJpY2U6IG51bWJlcjtcbiAgbWFya3VwUGVyY2VudGFnZTogbnVtYmVyO1xuICBzaXplczogQXJyYXk8eyBzaXplOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfT47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUXVvdGVDcmVhdGVJbXByaW50IHtcbiAgZGV0YWlsczogc3RyaW5nO1xuICBwcmljaW5nTWF0cml4Q29sdW1uSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBRdW90ZUNyZWF0ZUxpbmVJdGVtR3JvdXAge1xuICBwb3NpdGlvbjogbnVtYmVyO1xuICBsaW5lSXRlbXM6IFF1b3RlQ3JlYXRlTGluZUl0ZW1bXTtcbiAgaW1wcmludHM6IFF1b3RlQ3JlYXRlSW1wcmludFtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFF1b3RlQ3JlYXRlSW5wdXQge1xuICBjb250YWN0SWQ6IHN0cmluZztcbiAgY3VzdG9tZXJEdWVBdDogc3RyaW5nO1xuICBkdWVBdDogc3RyaW5nO1xuICBuaWNrbmFtZTogc3RyaW5nO1xuICBjdXN0b21lck5vdGU/OiBzdHJpbmc7XG4gIHByb2R1Y3Rpb25Ob3RlPzogc3RyaW5nO1xuICBsaW5lSXRlbUdyb3VwczogUXVvdGVDcmVhdGVMaW5lSXRlbUdyb3VwW107XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIHNpbmdsZSBuZXN0ZWQgUHJpbnRhdm8gcXVvdGVDcmVhdGUgbXV0YXRpb24uIElucHV0IHNoYXBlIHdhc1xuICogdmVyaWZpZWQgdGhyb3VnaCBsaXZlIHNjaGVtYSBpbnRyb3NwZWN0aW9uIGluIEF1Z3VzdCAyMDI2LiBFdmVyeSBlbnVtIHZhbHVlXG4gKiBpcyB2YWxpZGF0ZWQgYmVmb3JlIGl0IGlzIGVtaXR0ZWQgYXMgYW4gdW5xdW90ZWQgR3JhcGhRTCBsaXRlcmFsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVDcmVhdGVNdXRhdGlvbihpbnB1dDogUXVvdGVDcmVhdGVJbnB1dCk6IHN0cmluZyB7XG4gIGNvbnN0IGdyb3VwcyA9IGlucHV0LmxpbmVJdGVtR3JvdXBzLm1hcCgoZ3JvdXApID0+IHtcbiAgICBjb25zdCBsaW5lSXRlbXMgPSBncm91cC5saW5lSXRlbXMubWFwKChpdGVtKSA9PiB7XG4gICAgICBjb25zdCBzaXplcyA9IGl0ZW0uc2l6ZXMubWFwKFxuICAgICAgICAoc2l6ZSkgPT5cbiAgICAgICAgICBgeyBzaXplOiAke2VudW1MaXQoc2l6ZS5zaXplLCBcIkxpbmVJdGVtU2l6ZVwiKX0sIGNvdW50OiAke01hdGgudHJ1bmMoc2l6ZS5jb3VudCl9IH1gLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBgeyBwb3NpdGlvbjogJHtNYXRoLnRydW5jKGl0ZW0ucG9zaXRpb24pfSwgaXRlbU51bWJlcjogJHtsaXQoaXRlbS5pdGVtTnVtYmVyKX0sIGRlc2NyaXB0aW9uOiAke2xpdChpdGVtLmRlc2NyaXB0aW9uKX0sIGNvbG9yOiAke2xpdChpdGVtLmNvbG9yKX0sIHByaWNlOiAke051bWJlcihpdGVtLnByaWNlKS50b0ZpeGVkKDIpfSwgbWFya3VwUGVyY2VudGFnZTogJHtOdW1iZXIoaXRlbS5tYXJrdXBQZXJjZW50YWdlKS50b0ZpeGVkKDQpfSwgcHJvZHVjdFN0YXR1czogbmVlZF9vcmRlcmluZywgdGF4ZWQ6IHRydWUsIHNpemVzOiBbJHtzaXplcy5qb2luKFwiLCBcIil9XSB9YDtcbiAgICB9KTtcbiAgICBjb25zdCBpbXByaW50cyA9IGdyb3VwLmltcHJpbnRzLm1hcCgoaW1wcmludCkgPT4ge1xuICAgICAgcmV0dXJuIGB7IGRldGFpbHM6ICR7bGl0KGltcHJpbnQuZGV0YWlscyl9LCBwcmljaW5nTWF0cml4Q29sdW1uOiB7IGlkOiAke2xpdChpbXByaW50LnByaWNpbmdNYXRyaXhDb2x1bW5JZCl9IH0gfWA7XG4gICAgfSk7XG4gICAgcmV0dXJuIGB7IHBvc2l0aW9uOiAke01hdGgudHJ1bmMoZ3JvdXAucG9zaXRpb24pfSwgbGluZUl0ZW1zOiBbJHtsaW5lSXRlbXMuam9pbihcIiwgXCIpfV0sIGltcHJpbnRzOiBbJHtpbXByaW50cy5qb2luKFwiLCBcIil9XSB9YDtcbiAgfSk7XG5cbiAgY29uc3QgcGFydHMgPSBbXG4gICAgYGNvbnRhY3Q6IHsgaWQ6ICR7bGl0KGlucHV0LmNvbnRhY3RJZCl9IH1gLFxuICAgIGBjdXN0b21lckR1ZUF0OiAke2xpdChpbnB1dC5jdXN0b21lckR1ZUF0KX1gLFxuICAgIGBkdWVBdDogJHtsaXQoaW5wdXQuZHVlQXQpfWAsXG4gICAgYG5pY2tuYW1lOiAke2xpdChpbnB1dC5uaWNrbmFtZSl9YCxcbiAgICBgbGluZUl0ZW1Hcm91cHM6IFske2dyb3Vwcy5qb2luKFwiLCBcIil9XWAsXG4gIF07XG4gIGlmIChpbnB1dC5jdXN0b21lck5vdGUpIHBhcnRzLnB1c2goYGN1c3RvbWVyTm90ZTogJHtsaXQoaW5wdXQuY3VzdG9tZXJOb3RlKX1gKTtcbiAgaWYgKGlucHV0LnByb2R1Y3Rpb25Ob3RlKSB7XG4gICAgcGFydHMucHVzaChgcHJvZHVjdGlvbk5vdGU6ICR7bGl0KGlucHV0LnByb2R1Y3Rpb25Ob3RlKX1gKTtcbiAgfVxuXG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIHF1b3RlQ3JlYXRlKGlucHV0OiB7ICR7cGFydHMuam9pbihcIiwgXCIpfSB9KSB7XG4gICAgICBpZFxuICAgICAgdmlzdWFsSWRcbiAgICAgIHB1YmxpY1VybFxuICAgICAgbmlja25hbWVcbiAgICAgIHRvdGFsXG4gICAgICBjdXN0b21lckR1ZUF0XG4gICAgICBkdWVBdFxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwcm9kdWN0aW9uRmlsZUNyZWF0ZU11dGF0aW9uKFxuICBwYXJlbnRJZDogc3RyaW5nLFxuICBwdWJsaWNGaWxlVXJsOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICBwcm9kdWN0aW9uRmlsZUNyZWF0ZShwYXJlbnRJZDogJHtsaXQocGFyZW50SWQpfSwgcHVibGljRmlsZVVybDogJHtsaXQocHVibGljRmlsZVVybCl9KSB7XG4gICAgICBpZFxuICAgICAgZmlsZVVybFxuICAgIH1cbiAgfWA7XG59XG5cbi8qKlxuICogQ2hhbmdlIGFuIG9yZGVyJ3Mgc3RhdHVzLiBgcGFyZW50SWRgIGlzIHRoZSBpbnZvaWNlL3F1b3RlIEdyYXBoUUwgaWQ7XG4gKiByZXR1cm5zIE9yZGVyVW5pb24sIHNvIHRoZSBzZWxlY3Rpb24gbmVlZHMgaW5saW5lIGZyYWdtZW50cyAodmVyaWZpZWQgdmlhXG4gKiBpbnRyb3NwZWN0aW9uOiBzdGF0dXNVcGRhdGUocGFyZW50SWQ6IElEISwgc3RhdHVzSWQ6IElEISk6IE9yZGVyVW5pb24pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhdHVzVXBkYXRlTXV0YXRpb24ocGFyZW50SWQ6IHN0cmluZywgc3RhdHVzSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIHN0YXR1c1VwZGF0ZShwYXJlbnRJZDogJHtsaXQocGFyZW50SWQpfSwgc3RhdHVzSWQ6ICR7bGl0KHN0YXR1c0lkKX0pIHtcbiAgICAgIC4uLiBvbiBJbnZvaWNlIHsgaWQgc3RhdHVzIHsgaWQgbmFtZSB9IH1cbiAgICAgIC4uLiBvbiBRdW90ZSB7IGlkIHN0YXR1cyB7IGlkIG5hbWUgfSB9XG4gICAgfVxuICB9YDtcbn1cblxuLypcbiAqIFx1MjUwMFx1MjUwMCBUcmFuc2FjdGlvbnMgKGNhc2gtYmFzaXMgcGF5bWVudHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogUm9vdCBgdHJhbnNhY3Rpb25zYCBoYXMgcGFnaW5hdGlvbiBvbmx5IChubyBkYXRlIGZpbHRlciksIG5ld2VzdC1maXJzdC5cbiAqIFRyYW5zYWN0aW9uVW5pb24gbWVtYmVycyBhbGwgc2hhcmUgdGhlIHNhbWUgY29yZSBmaWVsZHM7IFBheW1lbnQgYWRkc1xuICogYHNvdXJjZWAsIFBheW1lbnREaXNwdXRlIGFkZHMgYHN0YXR1c2AuXG4gKi9cblxuY29uc3QgVFJBTlNBQ1RJT05fQ09SRV9GSUVMRFMgPSBgXG4gIGlkXG4gIGFtb3VudFxuICBjYXRlZ29yeVxuICBkZXNjcmlwdGlvblxuICBwcm9jZXNzaW5nXG4gIHRyYW5zYWN0aW9uRGF0ZVxuICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gIHRyYW5zYWN0ZWRGb3Ige1xuICAgIF9fdHlwZW5hbWVcbiAgICAuLi4gb24gSW52b2ljZSB7IGlkIHZpc3VhbElkIH1cbiAgICAuLi4gb24gUXVvdGUgeyBpZCB2aXN1YWxJZCB9XG4gICAgLi4uIG9uIE1lcmNoT3JkZXIgeyBpZCB9XG4gIH1cbmA7XG5cbmV4cG9ydCBmdW5jdGlvbiB0cmFuc2FjdGlvbnNQYWdlUXVlcnkoYWZ0ZXI/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgdHJhbnNhY3Rpb25zKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgIG5vZGVzIHtcbiAgICAgICAgX190eXBlbmFtZVxuICAgICAgICAuLi4gb24gUGF5bWVudCB7ICR7VFJBTlNBQ1RJT05fQ09SRV9GSUVMRFN9IHNvdXJjZSB9XG4gICAgICAgIC4uLiBvbiBSZWZ1bmQgeyAke1RSQU5TQUNUSU9OX0NPUkVfRklFTERTfSB9XG4gICAgICAgIC4uLiBvbiBSZXR1cm4geyAke1RSQU5TQUNUSU9OX0NPUkVfRklFTERTfSB9XG4gICAgICAgIC4uLiBvbiBWb2lkIHsgJHtUUkFOU0FDVElPTl9DT1JFX0ZJRUxEU30gfVxuICAgICAgICAuLi4gb24gUGF5bWVudERpc3B1dGUgeyAke1RSQU5TQUNUSU9OX0NPUkVfRklFTERTfSBzdGF0dXMgfVxuICAgICAgfVxuICAgICAgJHtQQUdFX0lORk99XG4gICAgfVxuICB9YDtcbn1cblxuLypcbiAqIFx1MjUwMFx1MjUwMCBUYXNrcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIFZlcmlmaWVkIHZpYSBsaXZlIGludHJvc3BlY3Rpb24gKyBsaXZlIHRlc3QgKEp1bHkgMjAyNik6XG4gKiAtIHRhc2tzKGZpcnN0LCBhZnRlciwgYXNzaWduZWVJZCwgY29tcGxldGVkLCBkdWVBZnRlciwgZHVlQmVmb3JlLCBzb3J0T24sXG4gKiAgIHNvcnREZXNjZW5kaW5nKTsgTk8gdXBkYXRlZEFmdGVyIGZpbHRlciBcdTIxOTIgc3luYyA9IGZ1bGwgb3Blbi10YXNrIHJlLXNjYW4uXG4gKiAtIHRhc2thYmxlOiBDdXN0b21lciB8IEludm9pY2UgfCBRdW90ZTsgbnVsbCA9IHN0YW5kYWxvbmUgXCJjYWxlbmRhclwiIHRhc2suXG4gKiAtIHRhc2tVcGRhdGUgaGFzIE1FUkdFIHNlbWFudGljczogc2VuZGluZyBvbmx5IHsgY29tcGxldGVkIH0gcHJlc2VydmVzXG4gKiAgIG5hbWUvZHVlQXQvYXNzaWduZWRUbyAobGl2ZS12ZXJpZmllZCBvbiBhIHRocm93YXdheSB0YXNrKS5cbiAqIC0gdGFza0RlbGV0ZSByZXR1cm5zIERlbGV0ZWRJRCBhbmQgcmVxdWlyZXMgYSBzZWxlY3Rpb24gc2V0LlxuICovXG5cbmNvbnN0IFRBU0tfTk9ERV9GSUVMRFMgPSBgXG4gIGlkXG4gIG5hbWVcbiAgZHVlQXRcbiAgY29tcGxldGVkXG4gIGNvbXBsZXRlZEF0XG4gIGFzc2lnbmVkVG8geyBpZCBuYW1lIGVtYWlsIH1cbiAgdGFza2FibGUge1xuICAgIF9fdHlwZW5hbWVcbiAgICAuLi4gb24gSW52b2ljZSB7IGlkIHZpc3VhbElkIG5pY2tuYW1lIGNvbnRhY3QgeyBmdWxsTmFtZSBjdXN0b21lciB7IGNvbXBhbnlOYW1lIH0gfSB9XG4gICAgLi4uIG9uIFF1b3RlIHsgaWQgdmlzdWFsSWQgbmlja25hbWUgY29udGFjdCB7IGZ1bGxOYW1lIGN1c3RvbWVyIHsgY29tcGFueU5hbWUgfSB9IH1cbiAgICAuLi4gb24gQ3VzdG9tZXIgeyBpZCB9XG4gIH1cbiAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuYDtcblxuZXhwb3J0IGZ1bmN0aW9uIHRhc2tzUGFnZVF1ZXJ5KGFyZ3M6IHtcbiAgYWZ0ZXI/OiBzdHJpbmcgfCBudWxsO1xuICBjb21wbGV0ZWQ/OiBib29sZWFuO1xufSA9IHt9KTogc3RyaW5nIHtcbiAgY29uc3QgY29tcGxldGVkQXJnID1cbiAgICBhcmdzLmNvbXBsZXRlZCAhPT0gdW5kZWZpbmVkID8gYCwgY29tcGxldGVkOiAke2FyZ3MuY29tcGxldGVkfWAgOiBcIlwiO1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICB0YXNrcyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhcmdzLmFmdGVyKX0ke2NvbXBsZXRlZEFyZ30pIHtcbiAgICAgIG5vZGVzIHsgJHtUQVNLX05PREVfRklFTERTfSB9XG4gICAgICAke1BBR0VfSU5GT31cbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdGFza0RldGFpbFF1ZXJ5KHRhc2tJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgdGFzayhpZDogJHtsaXQodGFza0lkKX0pIHsgJHtUQVNLX05PREVfRklFTERTfSB9XG4gIH1gO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRhc2tXcml0ZUlucHV0IHtcbiAgbmFtZT86IHN0cmluZztcbiAgLyoqIElTTzg2MDEgdGltZXN0YW1wIG9yIG51bGwgc2VtYW50aWNzIG5vdCBzdXBwb3J0ZWQgXHUyMDE0IG9taXQgdG8ga2VlcC4gKi9cbiAgZHVlQXQ/OiBzdHJpbmc7XG4gIGNvbXBsZXRlZD86IGJvb2xlYW47XG4gIC8qKiBQcmludGF2byBVc2VyLmlkIFx1MjAxNCBvbWl0IHRvIGtlZXAsIHNldCB0byBhc3NpZ24uICovXG4gIGFzc2lnbmVkVG9JZD86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gdGFza0lucHV0UGFydHMoaW5wdXQ6IFRhc2tXcml0ZUlucHV0KTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChpbnB1dC5uYW1lICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYG5hbWU6ICR7bGl0KGlucHV0Lm5hbWUpfWApO1xuICBpZiAoaW5wdXQuZHVlQXQgIT09IHVuZGVmaW5lZCkgcGFydHMucHVzaChgZHVlQXQ6ICR7bGl0KGlucHV0LmR1ZUF0KX1gKTtcbiAgaWYgKGlucHV0LmNvbXBsZXRlZCAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGBjb21wbGV0ZWQ6ICR7aW5wdXQuY29tcGxldGVkfWApO1xuICBpZiAoaW5wdXQuYXNzaWduZWRUb0lkICE9PSB1bmRlZmluZWQpIHtcbiAgICBwYXJ0cy5wdXNoKGBhc3NpZ25lZFRvOiB7IGlkOiAke2xpdChpbnB1dC5hc3NpZ25lZFRvSWQpfSB9YCk7XG4gIH1cbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCIsIFwiKTtcbn1cblxuLyoqIENyZWF0ZXMgYSBTVEFOREFMT05FIChjYWxlbmRhcikgdGFzayBcdTIwMTQgbm8gdGFza2FibGUgb24gcHVycG9zZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YXNrQ3JlYXRlTXV0YXRpb24oaW5wdXQ6IFRhc2tXcml0ZUlucHV0ICYgeyBuYW1lOiBzdHJpbmcgfSk6IHN0cmluZyB7XG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIHRhc2tDcmVhdGUoaW5wdXQ6IHsgJHt0YXNrSW5wdXRQYXJ0cyhpbnB1dCl9IH0pIHsgJHtUQVNLX05PREVfRklFTERTfSB9XG4gIH1gO1xufVxuXG4vKiogTUVSR0Ugc2VtYW50aWNzOiBvbmx5IHRoZSBwcm92aWRlZCBmaWVsZHMgY2hhbmdlIChsaXZlLXZlcmlmaWVkKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YXNrVXBkYXRlTXV0YXRpb24odGFza0lkOiBzdHJpbmcsIGlucHV0OiBUYXNrV3JpdGVJbnB1dCk6IHN0cmluZyB7XG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIHRhc2tVcGRhdGUoaWQ6ICR7bGl0KHRhc2tJZCl9LCBpbnB1dDogeyAke3Rhc2tJbnB1dFBhcnRzKGlucHV0KX0gfSkgeyAke1RBU0tfTk9ERV9GSUVMRFN9IH1cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0YXNrRGVsZXRlTXV0YXRpb24odGFza0lkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYG11dGF0aW9uIHtcbiAgICB0YXNrRGVsZXRlKGlkOiAke2xpdCh0YXNrSWQpfSkgeyBpZCB9XG4gIH1gO1xufVxuXG4vKiogQWNjb3VudCB1c2VycywgZm9yIG1hcHBpbmcgYXNzaWduZWUgZW1haWxzIFx1MjE5MiBQcmludGF2byB1c2VyIElEcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhY2NvdW50VXNlcnNRdWVyeShhZnRlcj86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBhY2NvdW50IHtcbiAgICAgIHVzZXJzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgICAgbm9kZXMgeyBpZCBuYW1lIGVtYWlsIH1cbiAgICAgICAgJHtQQUdFX0lORk99XG4gICAgICB9XG4gICAgfVxuICB9YDtcbn1cblxuLypcbiAqIFx1MjUwMFx1MjUwMCBPcmRlciBleHRyYXMgKGJhY2t1cCBtb2R1bGUsIGZ1bGwtZmlkZWxpdHkgY2FwdHVyZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gKiBQZXItb3JkZXIgc3VwcGxlbWVudGFsIHF1ZXJ5IGZvciBldmVyeXRoaW5nIHRoZSBob3Qgc3luYyBwYXRocyBza2lwOlxuICogZmVlcywgZXhwZW5zZXMsIGFwcHJvdmFsIHJlcXVlc3RzLCBwcm9kdWN0aW9uIGZpbGVzLCBjdXN0b20gYWRkcmVzc2VzLFxuICogdGhyZWFkIHN1bW1hcnksIHBheW1lbnQgcmVxdWVzdCwgcGx1cyBsaW5lLWl0ZW0vaW1wcmludCBlbnJpY2htZW50XG4gKiAobW9ja3VwcywgcGVyc29uYWxpemF0aW9ucywgcHJpY2UgcmVjZWlwdHMsIHByb2R1Y3QgY2F0YWxvZyByZWZzLCBQT1xuICogbGlua3MpLiBTdG9yZWQgYXMgb25lIHJhdyBibG9iIGluIHB2X29yZGVycy5leHRyYXMgXHUyMDE0IG5vIGhvdCBjb2x1bW5zLlxuICpcbiAqIENvbXBsZXhpdHkgYnVkZ2V0OiBrZXB0IHdlbGwgdW5kZXIgdGhlIDI1ayBjYXAgYnkgbW9kZXN0IGZpcnN0OiBsaW1pdHM7XG4gKiBldmVyeSBjb25uZWN0aW9uIGNhcnJpZXMgcGFnZUluZm8gc28gY2FsbGVycyBjYW4gZGV0ZWN0ICsgZm9sbG93XG4gKiBvdmVyZmxvdyB3aXRoIHRoZSB0YXJnZXRlZCBwYWdlIHF1ZXJpZXMgYmVsb3cuXG4gKi9cblxuLy8gUHJvYmVkIEp1bHkgMjAyNjogMTAvMjUvMTIvNiA9IGNvbXBsZXhpdHkgMjksOTc2ID4gMjVrIGNhcDsgOC8yMC8xMC81XG4vLyBsYW5kcyBzYWZlbHkgdW5kZXIuIEJpZ2dlciBvcmRlcnMganVzdCB0YWtlIGV4dHJhIGN1cnNvciBwYWdlcy5cbmV4cG9ydCBjb25zdCBFWFRSQVNfR1JPVVBTX0ZJUlNUID0gODtcbmV4cG9ydCBjb25zdCBFWFRSQVNfTElORV9JVEVNU19GSVJTVCA9IDIwO1xuZXhwb3J0IGNvbnN0IEVYVFJBU19JTVBSSU5UU19GSVJTVCA9IDEwO1xuZXhwb3J0IGNvbnN0IEVYVFJBU19NT0NLVVBTX0ZJUlNUID0gNTtcbmV4cG9ydCBjb25zdCBFWFRSQVNfQ09OTkVDVElPTl9GSVJTVCA9IDI1O1xuXG5jb25zdCBNT0NLVVBfRklFTERTID0gYFxuICBpZFxuICBmdWxsSW1hZ2VVcmxcbiAgdGh1bWJuYWlsVXJsXG4gIG1pbWVUeXBlXG4gIGRpc3BsYXlUaHVtYm5haWxcbiAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuYDtcblxuY29uc3QgRVhUUkFTX0xJTkVfSVRFTV9GSUVMRFMgPSBgXG4gIGlkXG4gIHBvc2l0aW9uXG4gIG1hcmt1cFBlcmNlbnRhZ2VcbiAgdGF4ZWRcbiAgcGVyc29uYWxpemF0aW9ucyB7IGlkIG5hbWUgcGVyc29uYWxpemF0aW9uIH1cbiAgcHJpY2VSZWNlaXB0IHsgZGVmYXVsdE1hcmt1cFBlcmNlbnRhZ2UgZGVzY3JpcHRpb24gcHJpY2Ugc2lnbmF0dXJlIH1cbiAgcHJvZHVjdCB7XG4gICAgaWRcbiAgICBicmFuZFxuICAgIGNvbG9yXG4gICAgZGVzY3JpcHRpb25cbiAgICBpdGVtTnVtYmVyXG4gICAgY2F0YWxvZyB7IGlkIG5hbWUgfVxuICB9XG4gIHBvTGluZUl0ZW0ge1xuICAgIGlkXG4gICAgcHVyY2hhc2VPcmRlciB7XG4gICAgICBpZFxuICAgICAgdmlzdWFsUG9JZFxuICAgICAgZ29vZHNTdGF0dXNcbiAgICAgIG5vdGVcbiAgICAgIHZlbmRvciB7IGlkIG5hbWUgY29tcGFueSBlbWFpbCBhY2NvdW50TnVtYmVyIH1cbiAgICB9XG4gIH1cbiAgbW9ja3VwcyhmaXJzdDogJHtFWFRSQVNfTU9DS1VQU19GSVJTVH0pIHtcbiAgICBub2RlcyB7ICR7TU9DS1VQX0ZJRUxEU30gfVxuICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICB9XG5gO1xuXG5jb25zdCBFWFRSQVNfSU1QUklOVF9GSUVMRFMgPSBgXG4gIGlkXG4gIG1vY2t1cHMoZmlyc3Q6ICR7RVhUUkFTX01PQ0tVUFNfRklSU1R9KSB7XG4gICAgbm9kZXMgeyAke01PQ0tVUF9GSUVMRFN9IH1cbiAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgfVxuYDtcblxuY29uc3QgRVhUUkFTX09SREVSX0NPTk5FQ1RJT05TID0gYFxuICBmZWVzKGZpcnN0OiAke0VYVFJBU19DT05ORUNUSU9OX0ZJUlNUfSkge1xuICAgIG5vZGVzIHtcbiAgICAgIGlkXG4gICAgICBhbW91bnRcbiAgICAgIGRlc2NyaXB0aW9uXG4gICAgICBxdWFudGl0eVxuICAgICAgdGF4YWJsZVxuICAgICAgdW5pdFByaWNlXG4gICAgICB1bml0UHJpY2VBc1BlcmNlbnRhZ2VcbiAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICB9XG4gICAgJHtQQUdFX0lORk99XG4gIH1cbiAgZXhwZW5zZXMoZmlyc3Q6ICR7RVhUUkFTX0NPTk5FQ1RJT05fRklSU1R9KSB7XG4gICAgbm9kZXMge1xuICAgICAgaWRcbiAgICAgIG5hbWVcbiAgICAgIGFtb3VudFxuICAgICAgdHJhbnNhY3Rpb25BdFxuICAgICAgdXNlckdlbmVyYXRlZFxuICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgIH1cbiAgICAke1BBR0VfSU5GT31cbiAgfVxuICBhcHByb3ZhbFJlcXVlc3RzKGZpcnN0OiAke0VYVFJBU19DT05ORUNUSU9OX0ZJUlNUfSkge1xuICAgIG5vZGVzIHtcbiAgICAgIGlkXG4gICAgICBuYW1lXG4gICAgICBzdGF0dXNcbiAgICAgIHJlcXVlc3RlciB7IGlkIG5hbWUgZW1haWwgfVxuICAgICAgcmV0cmFjdG9yIHsgaWQgbmFtZSBlbWFpbCB9XG4gICAgICByZXNwb25zZSB7IG5hbWUgZW1haWwgcmVhc29uIHJlc3BvbmRlZEF0IH1cbiAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICB9XG4gICAgJHtQQUdFX0lORk99XG4gIH1cbiAgcHJvZHVjdGlvbkZpbGVzKGZpcnN0OiAke0VYVFJBU19DT05ORUNUSU9OX0ZJUlNUfSkge1xuICAgIG5vZGVzIHtcbiAgICAgIGlkXG4gICAgICBuYW1lXG4gICAgICBmaWxlVXJsXG4gICAgICBtaW1lVHlwZVxuICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgIH1cbiAgICAke1BBR0VfSU5GT31cbiAgfVxuICBjdXN0b21BZGRyZXNzZXMoZmlyc3Q6ICR7RVhUUkFTX0NPTk5FQ1RJT05fRklSU1R9KSB7XG4gICAgbm9kZXMge1xuICAgICAgaWRcbiAgICAgIG5hbWVcbiAgICAgIGN1c3RvbWVyTmFtZVxuICAgICAgY29tcGFueU5hbWVcbiAgICAgIGFkZHJlc3MxXG4gICAgICBhZGRyZXNzMlxuICAgICAgY2l0eVxuICAgICAgc3RhdGVcbiAgICAgIHN0YXRlSXNvXG4gICAgICB6aXBDb2RlXG4gICAgICBjb3VudHJ5XG4gICAgICBjb3VudHJ5SXNvXG4gICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgfVxuICAgICR7UEFHRV9JTkZPfVxuICB9XG4gIHRocmVhZFN1bW1hcnkgeyBpZCB1bnJlYWQgfVxuICBwYXltZW50UmVxdWVzdCB7XG4gICAgaWRcbiAgICBhbW91bnRcbiAgICBkZXNjcmlwdGlvblxuICAgIG5pY2tuYW1lXG4gICAgc3RhdHVzXG4gICAgcmVxdWVzdGVkQXRcbiAgICB2aXN1YWxJZFxuICB9XG4gIGNvbnRyYWN0b3JQcm9maWxlIHsgaWQgY29tcGFueU5hbWUgZW1haWwgcGhvbmUgd2Vic2l0ZSBsb2dvIH1cbmA7XG5cbmZ1bmN0aW9uIGV4dHJhc0dyb3Vwc1NlbGVjdGlvbihhZnRlcj86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gYGxpbmVJdGVtR3JvdXBzKGZpcnN0OiAke0VYVFJBU19HUk9VUFNfRklSU1R9JHthZnRlckFyZyhhZnRlcil9KSB7XG4gICAgbm9kZXMge1xuICAgICAgaWRcbiAgICAgIGxpbmVJdGVtcyhmaXJzdDogJHtFWFRSQVNfTElORV9JVEVNU19GSVJTVH0pIHtcbiAgICAgICAgbm9kZXMgeyAke0VYVFJBU19MSU5FX0lURU1fRklFTERTfSB9XG4gICAgICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICAgICAgfVxuICAgICAgaW1wcmludHMoZmlyc3Q6ICR7RVhUUkFTX0lNUFJJTlRTX0ZJUlNUfSkge1xuICAgICAgICBub2RlcyB7ICR7RVhUUkFTX0lNUFJJTlRfRklFTERTfSB9XG4gICAgICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICAgICAgfVxuICAgIH1cbiAgICAke1BBR0VfSU5GT31cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvcmRlckV4dHJhc1F1ZXJ5KFxuICBraW5kOiBcImludm9pY2VcIiB8IFwicXVvdGVcIixcbiAgcHJpbnRhdm9JZDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgJHtraW5kfShpZDogJHtsaXQocHJpbnRhdm9JZCl9KSB7XG4gICAgICBpZFxuICAgICAgdmlzdWFsSWRcbiAgICAgICR7RVhUUkFTX09SREVSX0NPTk5FQ1RJT05TfVxuICAgICAgJHtleHRyYXNHcm91cHNTZWxlY3Rpb24oKX1cbiAgICB9XG4gIH1gO1xufVxuXG4vKiogRm9sbG93LXVwIHBhZ2Ugb2YgZXh0cmFzIGxpbmVJdGVtR3JvdXBzIChvcmRlcnMgd2l0aCA+MTAgZ3JvdXBzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvcmRlckV4dHJhc0dyb3Vwc1BhZ2VRdWVyeShcbiAga2luZDogXCJpbnZvaWNlXCIgfCBcInF1b3RlXCIsXG4gIHByaW50YXZvSWQ6IHN0cmluZyxcbiAgYWZ0ZXI6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgICR7a2luZH0oaWQ6ICR7bGl0KHByaW50YXZvSWQpfSkge1xuICAgICAgaWRcbiAgICAgICR7ZXh0cmFzR3JvdXBzU2VsZWN0aW9uKGFmdGVyKX1cbiAgICB9XG4gIH1gO1xufVxuXG4vKipcbiAqIEZvbGxvdy11cCBwYWdlIGZvciBhbiBvdmVyZmxvd2VkIG9yZGVyLWxldmVsIGV4dHJhcyBjb25uZWN0aW9uXG4gKiAoZmVlcyAvIGV4cGVuc2VzIC8gYXBwcm92YWxSZXF1ZXN0cyAvIHByb2R1Y3Rpb25GaWxlcyAvIGN1c3RvbUFkZHJlc3Nlc1xuICogYmV5b25kIHRoZSBmaXJzdCAyNSBcdTIwMTQgcmFyZSwgYnV0IHBhZ2VkIGZvciBjb3JyZWN0bmVzcykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvcmRlckV4dHJhc0Nvbm5lY3Rpb25QYWdlUXVlcnkoXG4gIGtpbmQ6IFwiaW52b2ljZVwiIHwgXCJxdW90ZVwiLFxuICBwcmludGF2b0lkOiBzdHJpbmcsXG4gIGNvbm5lY3Rpb246XG4gICAgfCBcImZlZXNcIlxuICAgIHwgXCJleHBlbnNlc1wiXG4gICAgfCBcImFwcHJvdmFsUmVxdWVzdHNcIlxuICAgIHwgXCJwcm9kdWN0aW9uRmlsZXNcIlxuICAgIHwgXCJjdXN0b21BZGRyZXNzZXNcIixcbiAgYWZ0ZXI6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHNlbGVjdGlvbnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgZmVlczogYGlkIGFtb3VudCBkZXNjcmlwdGlvbiBxdWFudGl0eSB0YXhhYmxlIHVuaXRQcmljZSB1bml0UHJpY2VBc1BlcmNlbnRhZ2UgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gICAgZXhwZW5zZXM6IGBpZCBuYW1lIGFtb3VudCB0cmFuc2FjdGlvbkF0IHVzZXJHZW5lcmF0ZWQgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gICAgYXBwcm92YWxSZXF1ZXN0czogYGlkIG5hbWUgc3RhdHVzIHJlcXVlc3RlciB7IGlkIG5hbWUgZW1haWwgfSByZXRyYWN0b3IgeyBpZCBuYW1lIGVtYWlsIH0gcmVzcG9uc2UgeyBuYW1lIGVtYWlsIHJlYXNvbiByZXNwb25kZWRBdCB9IHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICAgIHByb2R1Y3Rpb25GaWxlczogYGlkIG5hbWUgZmlsZVVybCBtaW1lVHlwZSB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgICBjdXN0b21BZGRyZXNzZXM6IGBpZCBuYW1lIGN1c3RvbWVyTmFtZSBjb21wYW55TmFtZSBhZGRyZXNzMSBhZGRyZXNzMiBjaXR5IHN0YXRlIHN0YXRlSXNvIHppcENvZGUgY291bnRyeSBjb3VudHJ5SXNvIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICB9O1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICAke2tpbmR9KGlkOiAke2xpdChwcmludGF2b0lkKX0pIHtcbiAgICAgIGlkXG4gICAgICAke2Nvbm5lY3Rpb259KGZpcnN0OiAke0VYVFJBU19DT05ORUNUSU9OX0ZJUlNUfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgICBub2RlcyB7ICR7c2VsZWN0aW9uc1tjb25uZWN0aW9uXX0gfVxuICAgICAgICAke1BBR0VfSU5GT31cbiAgICAgIH1cbiAgICB9XG4gIH1gO1xufVxuXG4vKlxuICogXHUyNTAwXHUyNTAwIEI0IGJhY2t1cCBlbnRpdGllcyAodGhyZWFkcy9tZXNzYWdlcywgbWVyY2gsIGlucXVpcmllcywgcGF5bWVudFxuICogICAgcmVxdWVzdHMsIGFjY291bnQgcmVmZXJlbmNlIGRhdGEpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogQWxsIHJhdy1ibG9iIGNhcHR1cmVzLiBJbnRyb3NwZWN0ZWQgbGl2ZSBKdWx5IDIwMjY6XG4gKiAtIHRocmVhZHMgXHUyMTkyIFRocmVhZFN1bW1hcnlDb25uZWN0aW9uIE9OTFkgKGlkLCB1bnJlYWQsIHJlZ2FyZGluZyxcbiAqICAgbGFzdFJlY2VpdmVkTWVzc2FnZSk7IGZ1bGwgbWVzc2FnZXMgcmVxdWlyZSB0aHJlYWQoaWQpe21lc3NhZ2VzfS5cbiAqICAgVGhlIGxpc3QgaXMgb3JkZXJlZCBieSBsYXN0UmVjZWl2ZWRNZXNzYWdlIHJlY2VuY3kgKHZlcmlmaWVkIGFjcm9zc1xuICogICBwYWdlcyksIGFuZCBsYXN0UmVjZWl2ZWRNZXNzYWdlIHRyYWNrcyBJTkNPTUlORyBtZXNzYWdlcyBvbmx5LlxuICogLSBtZXJjaCBvcmRlcnMgaGF2ZSBOTyByb290IGxpc3QgXHUyMDE0IG9ubHkgbWVyY2hTdG9yZShpZCkub3JkZXJzLlxuICogLSBQcmljaW5nTWF0cml4Q2VsbCBleHBvc2VzIE5PIHByaWNlL3F1YW50aXR5IHZhbHVlcyAoc3RydWN0dXJhbCBpZHNcbiAqICAgb25seSksIHNvIG1hdHJpY2VzIGFyZSBjYXB0dXJlZCB3aXRoIGNvbHVtbnMgYnV0IHdpdGhvdXQgY2VsbHMuXG4gKi9cblxuY29uc3QgVEhSRUFEX1JFR0FSRElORyA9IGBcbiAgcmVnYXJkaW5nIHtcbiAgICBfX3R5cGVuYW1lXG4gICAgLi4uIG9uIEludm9pY2UgeyBpZCB2aXN1YWxJZCB9XG4gICAgLi4uIG9uIFF1b3RlIHsgaWQgdmlzdWFsSWQgfVxuICB9XG5gO1xuXG5leHBvcnQgZnVuY3Rpb24gdGhyZWFkc1BhZ2VRdWVyeShhZnRlcj86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICB0aHJlYWRzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgIG5vZGVzIHtcbiAgICAgICAgaWRcbiAgICAgICAgdW5yZWFkXG4gICAgICAgICR7VEhSRUFEX1JFR0FSRElOR31cbiAgICAgICAgbGFzdFJlY2VpdmVkTWVzc2FnZSB7XG4gICAgICAgICAgX190eXBlbmFtZVxuICAgICAgICAgIC4uLiBvbiBFbWFpbE1lc3NhZ2UgeyBpZCB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IH0gfVxuICAgICAgICAgIC4uLiBvbiBUZXh0TWVzc2FnZSB7IGlkIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgfSB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbmNvbnN0IE1FU1NBR0VfUEFSVElDSVBBTlQgPSBgXG4gIF9fdHlwZW5hbWVcbiAgLi4uIG9uIENvbnRhY3QgeyBpZCBmdWxsTmFtZSBlbWFpbCB9XG4gIC4uLiBvbiBVc2VyIHsgaWQgbmFtZSBlbWFpbCB9XG5gO1xuXG5jb25zdCBNRVNTQUdFX0NPTU1PTl9GSUVMRFMgPSBgXG4gIGlkXG4gIGZyb21cbiAgdG9cbiAgaW5jb21pbmdcbiAgc3RhdHVzXG4gIHRleHRcbiAgc2VuZGVyIHsgJHtNRVNTQUdFX1BBUlRJQ0lQQU5UfSB9XG4gIHJlY2lwaWVudCB7ICR7TUVTU0FHRV9QQVJUSUNJUEFOVH0gfVxuICBhdHRhY2htZW50cyhmaXJzdDogMjUpIHtcbiAgICBub2RlcyB7IGZpbGVuYW1lIHVybCB9XG4gICAgcGFnZUluZm8geyBoYXNOZXh0UGFnZSB9XG4gIH1cbiAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuYDtcblxuLyoqIE9uZSBwYWdlIG9mIGEgdGhyZWFkJ3MgZnVsbCBtZXNzYWdlcyAoMjUvcGFnZSwgcGFnZWQgdG8gZXhoYXVzdGlvbikuICovXG5leHBvcnQgZnVuY3Rpb24gdGhyZWFkTWVzc2FnZXNQYWdlUXVlcnkoXG4gIHRocmVhZElkOiBzdHJpbmcsXG4gIGFmdGVyPzogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIHRocmVhZChpZDogJHtsaXQodGhyZWFkSWQpfSkge1xuICAgICAgaWRcbiAgICAgIHVucmVhZFxuICAgICAgbWVzc2FnZXMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgICBub2RlcyB7XG4gICAgICAgICAgX190eXBlbmFtZVxuICAgICAgICAgIC4uLiBvbiBFbWFpbE1lc3NhZ2UgeyAke01FU1NBR0VfQ09NTU9OX0ZJRUxEU30gc3ViamVjdCBjYyBiY2MgfVxuICAgICAgICAgIC4uLiBvbiBUZXh0TWVzc2FnZSB7ICR7TUVTU0FHRV9DT01NT05fRklFTERTfSB9XG4gICAgICAgIH1cbiAgICAgICAgJHtQQUdFX0lORk99XG4gICAgICB9XG4gICAgfVxuICB9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlucXVpcmllc1BhZ2VRdWVyeShhZnRlcj86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBpbnF1aXJpZXMoZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgbm9kZXMge1xuICAgICAgICBpZFxuICAgICAgICBuYW1lXG4gICAgICAgIGVtYWlsXG4gICAgICAgIHBob25lXG4gICAgICAgIHJlcXVlc3RcbiAgICAgICAgdW5yZWFkXG4gICAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICAgIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbi8qKlxuICogUGF5bWVudCByZXF1ZXN0cywgbmV3ZXN0LWZpcnN0LiBMaXN0IHBhZ2Ugc2l6ZSAxMCAobm90IDI1KSBcdTIwMTQgdGhlIHR3b1xuICogbmVzdGVkIGZpcnN0OjI1IGNvbm5lY3Rpb25zIHdvdWxkIG90aGVyd2lzZSByaXNrIHRoZSAyNWsgY29tcGxleGl0eVxuICogY2FwIChwcm9iZWQgT0sgbGl2ZSBhdCAxMC8yNS8yNSwgSnVseSAyMDI2KS5cbiAqL1xuZXhwb3J0IGNvbnN0IFBBWU1FTlRfUkVRVUVTVFNfUEFHRV9TSVpFID0gMTA7XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXltZW50UmVxdWVzdHNQYWdlUXVlcnkoXG4gIGFmdGVyPzogc3RyaW5nIHwgbnVsbCxcbiAgb3B0aW9ucz86IHsgb21pdFJlcXVlc3RlZEJ5PzogYm9vbGVhbiB9LFxuKTogc3RyaW5nIHtcbiAgLy8gUHJpbnRhdm8gZGVjbGFyZXMgUGF5bWVudFJlcXVlc3QucmVxdWVzdGVkQnkgbm9uLW51bGxhYmxlLCBidXQgaXRcbiAgLy8gQ0FOIGJlIG51bGwgaW4gcHJhY3RpY2UgKHJlcXVlc3RpbmcgdXNlciBkZWxldGVkKSBcdTIwMTQgYW5kIHRoZSB3aG9sZVxuICAvLyByZXNwb25zZSBkYXRhIG51bGxzIG91dCAodmVyaWZpZWQgbGl2ZTogbm8gcGFydGlhbCBkYXRhIHN1cnZpdmVzKS5cbiAgLy8gQ2FsbGVycyByZXRyeSB0aGUgcG9pc29uZWQgcGFnZSB3aXRob3V0IHRoZSBmaWVsZC5cbiAgY29uc3QgcmVxdWVzdGVkQnlGaWVsZCA9IG9wdGlvbnM/Lm9taXRSZXF1ZXN0ZWRCeVxuICAgID8gXCJcIlxuICAgIDogXCJcXG4gICAgICAgIHJlcXVlc3RlZEJ5IHsgaWQgbmFtZSBlbWFpbCB9XCI7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIHBheW1lbnRSZXF1ZXN0cyhmaXJzdDogJHtQQVlNRU5UX1JFUVVFU1RTX1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0sIHNvcnREZXNjZW5kaW5nOiB0cnVlKSB7XG4gICAgICBub2RlcyB7XG4gICAgICAgIGlkXG4gICAgICAgIHZpc3VhbElkXG4gICAgICAgIGFtb3VudFxuICAgICAgICBkZXNjcmlwdGlvblxuICAgICAgICBuaWNrbmFtZVxuICAgICAgICBzdGF0dXNcbiAgICAgICAgcmVxdWVzdGVkQXQke3JlcXVlc3RlZEJ5RmllbGR9XG4gICAgICAgIGNvbnRhY3QgeyBpZCBjb21wYW55TmFtZSB9XG4gICAgICAgIHJlcXVlc3RlZERldGFpbHMoZmlyc3Q6IDI1KSB7XG4gICAgICAgICAgbm9kZXMge1xuICAgICAgICAgICAgaWRcbiAgICAgICAgICAgIG9yZGVyVmlzdWFsSWRcbiAgICAgICAgICAgIHJlcXVlc3RlZEFtb3VudFxuICAgICAgICAgICAgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBwYWdlSW5mbyB7IGhhc05leHRQYWdlIH1cbiAgICAgICAgfVxuICAgICAgICBwYXltZW50cyhmaXJzdDogMjUpIHtcbiAgICAgICAgICBub2RlcyB7XG4gICAgICAgICAgICBpZFxuICAgICAgICAgICAgYW1vdW50XG4gICAgICAgICAgICBjYXRlZ29yeVxuICAgICAgICAgICAgZGVzY3JpcHRpb25cbiAgICAgICAgICAgIHByb2Nlc3NpbmdcbiAgICAgICAgICAgIHNvdXJjZVxuICAgICAgICAgICAgdHJhbnNhY3Rpb25EYXRlXG4gICAgICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICAgICAgfVxuICAgICAgICAgIHBhZ2VJbmZvIHsgaGFzTmV4dFBhZ2UgfVxuICAgICAgICB9XG4gICAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICAgIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtZXJjaFN0b3Jlc1BhZ2VRdWVyeShhZnRlcj86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gYHF1ZXJ5IHtcbiAgICBtZXJjaFN0b3JlcyhmaXJzdDogJHtQQUdFX1NJWkV9JHthZnRlckFyZyhhZnRlcil9KSB7XG4gICAgICBub2RlcyB7XG4gICAgICAgIGlkXG4gICAgICAgIG5hbWVcbiAgICAgICAgc3RhdHVzXG4gICAgICAgIGNsb3Nlc0F0XG4gICAgICAgIHN1bW1hcnkgeyBpdGVtc1NvbGQgdG90YWxTYWxlcyB0b3RhbFRheCB9XG4gICAgICAgIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1cbiAgICAgIH1cbiAgICAgICR7UEFHRV9JTkZPfVxuICAgIH1cbiAgfWA7XG59XG5cbmNvbnN0IE1FUkNIX0FERFJFU1NfRklFTERTID0gYFxuICBpZFxuICBuYW1lXG4gIHBob25lXG4gIHJlc2lkZW50aWFsXG4gIGFkZHJlc3MxXG4gIGFkZHJlc3MyXG4gIGNpdHlcbiAgc3RhdGVcbiAgc3RhdGVJc29cbiAgemlwQ29kZVxuICBjb3VudHJ5XG4gIGNvdW50cnlJc29cbmA7XG5cbi8qKiBPbmUgcGFnZSBvZiBhIG1lcmNoIHN0b3JlJ3Mgb3JkZXJzIChvbmx5IHJlYWNoYWJsZSBwZXItc3RvcmUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmNoU3RvcmVPcmRlcnNQYWdlUXVlcnkoXG4gIHN0b3JlSWQ6IHN0cmluZyxcbiAgYWZ0ZXI/OiBzdHJpbmcgfCBudWxsLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBxdWVyeSB7XG4gICAgbWVyY2hTdG9yZShpZDogJHtsaXQoc3RvcmVJZCl9KSB7XG4gICAgICBpZFxuICAgICAgb3JkZXJzKGZpcnN0OiAke1BBR0VfU0laRX0ke2FmdGVyQXJnKGFmdGVyKX0pIHtcbiAgICAgICAgbm9kZXMge1xuICAgICAgICAgIGlkXG4gICAgICAgICAgdmlzdWFsSWRcbiAgICAgICAgICBzdGF0dXNcbiAgICAgICAgICBxdWFudGl0eVxuICAgICAgICAgIGl0ZW1Ub3RhbFxuICAgICAgICAgIHByb21vVG90YWxcbiAgICAgICAgICB0YXhcbiAgICAgICAgICB0b3RhbFxuICAgICAgICAgIGNvbXBsZXRlZEF0XG4gICAgICAgICAgZGVsaXZlcnkgeyBmbGF0UmF0ZSBtZXRob2QgdG90YWwgdG90YWxBY3R1YWwgfVxuICAgICAgICAgIGJpbGxpbmdBZGRyZXNzIHsgJHtNRVJDSF9BRERSRVNTX0ZJRUxEU30gfVxuICAgICAgICAgIHNoaXBwaW5nQWRkcmVzcyB7ICR7TUVSQ0hfQUREUkVTU19GSUVMRFN9IH1cbiAgICAgICAgICB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9XG4gICAgICAgIH1cbiAgICAgICAgJHtQQUdFX0lORk99XG4gICAgICB9XG4gICAgfVxuICB9YDtcbn1cblxuLyoqXG4gKiBBY2NvdW50LWxldmVsIHJlZmVyZW5jZSBjb25uZWN0aW9ucywgb25lIHF1ZXJ5IHBlciBraW5kLiBLaW5kIGtleXNcbiAqIGRvdWJsZSBhcyBwdl9yZWZlcmVuY2VfYmxvYnMua2luZCB2YWx1ZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBSRUZFUkVOQ0VfS0lORFMgPSBbXG4gIFwiZGVsaXZlcnlfbWV0aG9kXCIsXG4gIFwicGF5bWVudF90ZXJtXCIsXG4gIFwidXNlclwiLFxuICBcInByaWNpbmdfbWF0cml4XCIsXG4gIFwiZW1haWxfdGVtcGxhdGVcIixcbiAgXCJ0eXBlX29mX3dvcmtcIixcbiAgXCJjYXRlZ29yeVwiLFxuICBcInByZXNldF90YXNrX2dyb3VwXCIsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBSZWZlcmVuY2VLaW5kID0gKHR5cGVvZiBSRUZFUkVOQ0VfS0lORFMpW251bWJlcl07XG5cbmNvbnN0IFJFRkVSRU5DRV9TRUxFQ1RJT05TOiBSZWNvcmQ8UmVmZXJlbmNlS2luZCwgeyBmaWVsZDogc3RyaW5nOyBzZWxlY3Rpb246IHN0cmluZyB9PiA9IHtcbiAgZGVsaXZlcnlfbWV0aG9kOiB7XG4gICAgZmllbGQ6IFwiZGVsaXZlcnlNZXRob2RzXCIsXG4gICAgc2VsZWN0aW9uOiBgaWQgbmFtZSBhcmNoaXZlZCB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgfSxcbiAgcGF5bWVudF90ZXJtOiB7XG4gICAgZmllbGQ6IFwicGF5bWVudFRlcm1zXCIsXG4gICAgc2VsZWN0aW9uOiBgaWQgbmFtZSBkYXlzIGFyY2hpdmVkIGluVXNlIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICB9LFxuICB1c2VyOiB7XG4gICAgZmllbGQ6IFwidXNlcnNcIixcbiAgICBzZWxlY3Rpb246IGBpZCBuYW1lIGVtYWlsIHBob25lIHRpbWVab25lIHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICB9LFxuICBwcmljaW5nX21hdHJpeDoge1xuICAgIGZpZWxkOiBcInByaWNpbmdNYXRyaWNlc1wiLFxuICAgIHNlbGVjdGlvbjogYGlkIG5hbWUgdHlwZU9mV29yayB7IGlkIG5hbWUgYXJjaGl2ZWQgfSBjb2x1bW5zIHsgaWQgY29sdW1uTmFtZSB9IHRpbWVzdGFtcHMgeyBjcmVhdGVkQXQgdXBkYXRlZEF0IH1gLFxuICB9LFxuICBlbWFpbF90ZW1wbGF0ZToge1xuICAgIGZpZWxkOiBcImVtYWlsVGVtcGxhdGVzXCIsXG4gICAgc2VsZWN0aW9uOiBgaWQgbmFtZSBzdWJqZWN0IGJvZHkgdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gIH0sXG4gIHR5cGVfb2Zfd29yazoge1xuICAgIGZpZWxkOiBcInR5cGVzT2ZXb3JrXCIsXG4gICAgc2VsZWN0aW9uOiBgaWQgbmFtZSBhcmNoaXZlZCB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgfSxcbiAgY2F0ZWdvcnk6IHtcbiAgICBmaWVsZDogXCJjYXRlZ29yaWVzXCIsXG4gICAgc2VsZWN0aW9uOiBgaWQgbmFtZSB0aW1lc3RhbXBzIHsgY3JlYXRlZEF0IHVwZGF0ZWRBdCB9YCxcbiAgfSxcbiAgcHJlc2V0X3Rhc2tfZ3JvdXA6IHtcbiAgICBmaWVsZDogXCJwcmVzZXRUYXNrR3JvdXBzXCIsXG4gICAgc2VsZWN0aW9uOiBgaWQgdGl0bGUgcHJlc2V0VGFza3MoZmlyc3Q6IDI1KSB7IG5vZGVzIHsgaWQgbmFtZSBwb3NpdGlvbiBhc3NpZ25lZFRvIHsgaWQgbmFtZSBlbWFpbCB9IH0gcGFnZUluZm8geyBoYXNOZXh0UGFnZSB9IH0gdGltZXN0YW1wcyB7IGNyZWF0ZWRBdCB1cGRhdGVkQXQgfWAsXG4gIH0sXG59O1xuXG4vKiogVGhlIGFjY291bnQgY29ubmVjdGlvbiBmaWVsZCBuYW1lIGZvciBhIHJlZmVyZW5jZSBraW5kIChmb3IgcmVzcG9uc2UgcGFyc2luZykuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmZXJlbmNlRmllbGRGb3Ioa2luZDogUmVmZXJlbmNlS2luZCk6IHN0cmluZyB7XG4gIHJldHVybiBSRUZFUkVOQ0VfU0VMRUNUSU9OU1traW5kXS5maWVsZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFjY291bnRSZWZlcmVuY2VQYWdlUXVlcnkoXG4gIGtpbmQ6IFJlZmVyZW5jZUtpbmQsXG4gIGFmdGVyPzogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHsgZmllbGQsIHNlbGVjdGlvbiB9ID0gUkVGRVJFTkNFX1NFTEVDVElPTlNba2luZF07XG4gIHJldHVybiBgcXVlcnkge1xuICAgIGFjY291bnQge1xuICAgICAgJHtmaWVsZH0oZmlyc3Q6ICR7UEFHRV9TSVpFfSR7YWZ0ZXJBcmcoYWZ0ZXIpfSkge1xuICAgICAgICBub2RlcyB7ICR7c2VsZWN0aW9ufSB9XG4gICAgICAgICR7UEFHRV9JTkZPfVxuICAgICAgfVxuICAgIH1cbiAgfWA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBIdWIgUHJpY2UgQ2FsY3VsYXRvciBtdXRhdGlvbnMgKGFkZGVkIGZvciBUYXNrICMyNykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRmV0Y2ggYSBzaW5nbGUgaW52b2ljZSBieSBpdHMgaW50ZXJuYWwgUHJpbnRhdm8gaWQsIHJldHVybmluZyBvbmx5IHRoZVxuICogZmllbGRzIG5lZWRlZCBieSB0aGUgSHViIFByaWNlIENhbGN1bGF0b3IgcHVzaCAocHJvZHVjdGlvbk5vdGUgKyBpZC92aXN1YWxJZCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbnZvaWNlQnlJZFF1ZXJ5KHByaW50YXZvSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIGludm9pY2UoaWQ6ICR7bGl0KHByaW50YXZvSWQpfSkge1xuICAgICAgaWRcbiAgICAgIHZpc3VhbElkXG4gICAgICBwcm9kdWN0aW9uTm90ZVxuICAgIH1cbiAgfWA7XG59XG5cbi8qKlxuICogRmV0Y2ggYSBzaW5nbGUgcXVvdGUgYnkgaXRzIGludGVybmFsIFByaW50YXZvIGlkLCByZXR1cm5pbmcgb25seSB0aGVcbiAqIGZpZWxkcyBuZWVkZWQgYnkgdGhlIEh1YiBQcmljZSBDYWxjdWxhdG9yIHB1c2ggKHByb2R1Y3Rpb25Ob3RlICsgaWQvdmlzdWFsSWQpLlxuICpcbiAqIE5PVEU6IFF1b3RlLnZpc3VhbElkIGlzIGEgU3RyaW5nIGluIHRoZSBQcmludGF2byBzY2hlbWEgKEludm9pY2UudmlzdWFsSWRcbiAqIGlzIGFuIEludCkgXHUyMDE0IGNhbGxlcnMgbXVzdCBub3JtYWxpemUgd2l0aCBOdW1iZXIoKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHF1b3RlQnlJZFF1ZXJ5KHByaW50YXZvSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgcXVlcnkge1xuICAgIHF1b3RlKGlkOiAke2xpdChwcmludGF2b0lkKX0pIHtcbiAgICAgIGlkXG4gICAgICB2aXN1YWxJZFxuICAgICAgcHJvZHVjdGlvbk5vdGVcbiAgICB9XG4gIH1gO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEludm9pY2VVcGRhdGVJbnB1dCB7XG4gIHByb2R1Y3Rpb25Ob3RlPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFVwZGF0ZSBhbiBpbnZvaWNlJ3MgbXV0YWJsZSBoZWFkZXIgZmllbGRzIChIdWIgUHJpY2UgQ2FsY3VsYXRvciBwdXNoKS5cbiAqIE9ubHkgbm9uLXVuZGVmaW5lZCBmaWVsZHMgYXJlIGVtaXR0ZWQuXG4gKiBVc2VzIGBpbnZvaWNlVXBkYXRlKGlkLCBpbnB1dClgIFx1MjAxNCB2ZXJpZmllZCB2aWEgUHJpbnRhdm8gc2NoZW1hLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW52b2ljZVVwZGF0ZU11dGF0aW9uKFxuICBpbnZvaWNlSWQ6IHN0cmluZyxcbiAgaW5wdXQ6IEludm9pY2VVcGRhdGVJbnB1dCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoaW5wdXQucHJvZHVjdGlvbk5vdGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHBhcnRzLnB1c2goYHByb2R1Y3Rpb25Ob3RlOiAke2xpdChpbnB1dC5wcm9kdWN0aW9uTm90ZSl9YCk7XG4gIH1cbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImludm9pY2VVcGRhdGVNdXRhdGlvbjogYXQgbGVhc3Qgb25lIGZpZWxkIG11c3QgYmUgcHJvdmlkZWRcIik7XG4gIH1cbiAgcmV0dXJuIGBtdXRhdGlvbiB7XG4gICAgaW52b2ljZVVwZGF0ZShpZDogJHtsaXQoaW52b2ljZUlkKX0sIGlucHV0OiB7ICR7cGFydHMuam9pbihcIiwgXCIpfSB9KSB7XG4gICAgICBpZFxuICAgICAgdmlzdWFsSWRcbiAgICAgIHByb2R1Y3Rpb25Ob3RlXG4gICAgfVxuICB9YDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBRdW90ZVVwZGF0ZUlucHV0IHtcbiAgcHJvZHVjdGlvbk5vdGU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogVXBkYXRlIGEgcXVvdGUncyBtdXRhYmxlIGhlYWRlciBmaWVsZHMgKEh1YiBQcmljZSBDYWxjdWxhdG9yIHB1c2gpLlxuICogT25seSBub24tdW5kZWZpbmVkIGZpZWxkcyBhcmUgZW1pdHRlZC5cbiAqIFVzZXMgYHF1b3RlVXBkYXRlKGlkLCBpbnB1dClgIHdpdGggUHJpbnRhdm8ncyBRdW90ZUlucHV0IHR5cGUgXHUyMDE0IHZlcmlmaWVkXG4gKiB2aWEgc2NoZW1hIGludHJvc3BlY3Rpb24gdGhhdCBRdW90ZUlucHV0IGluY2x1ZGVzIHByb2R1Y3Rpb25Ob3RlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVVcGRhdGVNdXRhdGlvbihcbiAgcXVvdGVJZDogc3RyaW5nLFxuICBpbnB1dDogUXVvdGVVcGRhdGVJbnB1dCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoaW5wdXQucHJvZHVjdGlvbk5vdGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHBhcnRzLnB1c2goYHByb2R1Y3Rpb25Ob3RlOiAke2xpdChpbnB1dC5wcm9kdWN0aW9uTm90ZSl9YCk7XG4gIH1cbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInF1b3RlVXBkYXRlTXV0YXRpb246IGF0IGxlYXN0IG9uZSBmaWVsZCBtdXN0IGJlIHByb3ZpZGVkXCIpO1xuICB9XG4gIHJldHVybiBgbXV0YXRpb24ge1xuICAgIHF1b3RlVXBkYXRlKGlkOiAke2xpdChxdW90ZUlkKX0sIGlucHV0OiB7ICR7cGFydHMuam9pbihcIiwgXCIpfSB9KSB7XG4gICAgICBpZFxuICAgICAgdmlzdWFsSWRcbiAgICAgIHByb2R1Y3Rpb25Ob3RlXG4gICAgfVxuICB9YDtcbn1cbiIsICJpbXBvcnQgeyBQcmludGF2b0NsaWVudCwgdHlwZSBQcmludGF2b0NsaWVudFN0YXRzIH0gZnJvbSBcIkB3b3Jrc3BhY2UvcHJpbnRhdm9cIjtcblxubGV0IGNsaWVudDogUHJpbnRhdm9DbGllbnQgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHByaW50YXZvQ29uZmlndXJlZCgpOiBib29sZWFuIHtcbiAgcmV0dXJuIEJvb2xlYW4oXG4gICAgcHJvY2Vzcy5lbnZbXCJQUklOVEFWT19BUElfRU1BSUxcIl0gJiYgcHJvY2Vzcy5lbnZbXCJQUklOVEFWT19BUElfVE9LRU5cIl0sXG4gICk7XG59XG5cbi8qKlxuICogVGhlIHNpbmdsZSBzaGFyZWQgZ2F0ZXdheS4gRXZlcnkgUHJpbnRhdm8gY2FsbCBpbiB0aGUgZW50aXJlIEh1YiBtdXN0IGdvXG4gKiB0aHJvdWdoIHRoaXMgY2xpZW50IHNvIHRoZSBpbi1wcm9jZXNzIHRocm90dGxlIGFjdHVhbGx5IHByb3RlY3RzIHRoZVxuICogYWNjb3VudC13aWRlIDEwIHJlcS81cyBsaW1pdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFByaW50YXZvQ2xpZW50KCk6IFByaW50YXZvQ2xpZW50IHtcbiAgaWYgKCFjbGllbnQpIHtcbiAgICBjb25zdCBlbWFpbCA9IHByb2Nlc3MuZW52W1wiUFJJTlRBVk9fQVBJX0VNQUlMXCJdO1xuICAgIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnZbXCJQUklOVEFWT19BUElfVE9LRU5cIl07XG4gICAgaWYgKCFlbWFpbCB8fCAhdG9rZW4pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJQUklOVEFWT19BUElfRU1BSUwgYW5kIFBSSU5UQVZPX0FQSV9UT0tFTiBtdXN0IGJlIHNldCB0byB0YWxrIHRvIFByaW50YXZvXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjbGllbnQgPSBuZXcgUHJpbnRhdm9DbGllbnQoeyBlbWFpbCwgdG9rZW4gfSk7XG4gIH1cbiAgcmV0dXJuIGNsaWVudDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHByaW50YXZvQ2xpZW50U3RhdHMoKTogUHJpbnRhdm9DbGllbnRTdGF0cyB8IG51bGwge1xuICByZXR1cm4gY2xpZW50ID8gY2xpZW50LnN0YXRzIDogbnVsbDtcbn1cbiIsICJpbXBvcnQge1xuICBpbnZvaWNlc1BhZ2VRdWVyeSxcbiAgcXVvdGVzUGFnZVF1ZXJ5LFxuICBzaW5nbGVPcmRlclN0YXR1c1F1ZXJ5LFxuICB0eXBlIENvbm5lY3Rpb24sXG4gIHR5cGUgSW52b2ljZXNQYWdlLFxuICB0eXBlIE9yZGVyS2luZCxcbiAgdHlwZSBQdk9yZGVyTm9kZSxcbiAgdHlwZSBRdW90ZXNQYWdlLFxuICB0eXBlIFNpbmdsZU9yZGVyU3RhdHVzLFxufSBmcm9tIFwiQHdvcmtzcGFjZS9wcmludGF2b1wiO1xuaW1wb3J0IHsgZ2V0UHJpbnRhdm9DbGllbnQgfSBmcm9tIFwiLi4vLi4vcHJpbnRhdm9HYXRld2F5XCI7XG5cbi8qKlxuICogQSBkZWxpYmVyYXRlbHkgc21hbGwgY2xpZW50IHN1cmZhY2Uga2VlcHMgbGl2ZSBkaXNjb3ZlcnkgdW5pdC10ZXN0YWJsZSB3aGlsZVxuICogc3RpbGwgcmVxdWlyaW5nIHRoZSBwcm9kdWN0aW9uIGNhbGxlciB0byB1c2UgdGhlIHNoYXJlZCBQcmludGF2byBnYXRld2F5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIExpdmVPcmRlclF1ZXJ5Q2xpZW50IHtcbiAgcXVlcnk8VD4oXG4gICAgcXVlcnk6IHN0cmluZyxcbiAgICB2YXJpYWJsZXM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgKTogUHJvbWlzZTxUPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBMaXZlQXV0b1ByaW50T3JkZXIge1xuICBraW5kOiBPcmRlcktpbmQ7XG4gIG5vZGU6IFB2T3JkZXJOb2RlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIExpdmVEaXNjb3ZlcnlSZXN1bHQge1xuICBvcmRlcnM6IExpdmVBdXRvUHJpbnRPcmRlcltdO1xuICBwYWdlczogUmVjb3JkPFwiaW52b2ljZXNcIiB8IFwicXVvdGVzXCIsIG51bWJlcj47XG59XG5cbmV4cG9ydCB0eXBlIExpdmVEaXNjb3ZlcnlFcnJvcktpbmQgPVxuICB8IFwicmVxdWVzdFwiXG4gIHwgXCJ1bnN1cHBvcnRlZF9maWx0ZXJcIlxuICB8IFwiaW5jb21wbGV0ZV9wYWdpbmF0aW9uXCJcbiAgfCBcImludmFsaWRfcmVzcG9uc2VcIjtcblxuLyoqXG4gKiBEaXNjb3ZlcnkgZXJyb3JzIGFyZSBpbnRlbnRpb25hbGx5IGRpc3RpbmN0IGZyb20gcGVyLW9yZGVyIHByaW50IGVycm9ycy5cbiAqIFRoZSBlbmdpbmUgbXVzdCBmYWlsIHRoZSBydW4gYmVmb3JlIHJlbmRlcmluZyBvciBzdWJtaXR0aW5nIGFueXRoaW5nIHdoZW5cbiAqIGxpdmUgZGlzY292ZXJ5IGlzIG5vdCBjb21wbGV0ZS5cbiAqL1xuZXhwb3J0IGNsYXNzIExpdmVEaXNjb3ZlcnlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHB1YmxpYyByZWFkb25seSBraW5kOiBMaXZlRGlzY292ZXJ5RXJyb3JLaW5kLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkxpdmVEaXNjb3ZlcnlFcnJvclwiO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGl2ZU9yZGVyU3RhdHVzIHtcbiAgb3JkZXJJZDogc3RyaW5nO1xuICB2aXN1YWxJZDogbnVtYmVyIHwgbnVsbDtcbiAgc3RhdHVzSWQ6IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1c05hbWU6IHN0cmluZyB8IG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVZpc3VhbElkKHJhdzogdW5rbm93bik6IG51bWJlciB8IG51bGwge1xuICBjb25zdCB2aXN1YWxJZCA9XG4gICAgdHlwZW9mIHJhdyA9PT0gXCJudW1iZXJcIlxuICAgICAgPyByYXdcbiAgICAgIDogdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiAmJiAvXlxcZCskLy50ZXN0KHJhdy50cmltKCkpXG4gICAgICAgID8gTnVtYmVyKHJhdylcbiAgICAgICAgOiBOdW1iZXIuTmFOO1xuICByZXR1cm4gTnVtYmVyLmlzU2FmZUludGVnZXIodmlzdWFsSWQpID8gdmlzdWFsSWQgOiBudWxsO1xufVxuXG4vKipcbiAqIFJlYWQgb25lIGV4YWN0IG9yZGVyJ3MgY3VycmVudCBzdGF0dXMgdGhyb3VnaCB0aGUgc2hhcmVkIGdhdGV3YXkuIFRoaXMgaXNcbiAqIGludGVudGlvbmFsbHkgc2VwYXJhdGUgZnJvbSBkZXRhaWwgcmVmcmVzaDogZGV0YWlsIHF1ZXJpZXMgZG8gbm90IGluY2x1ZGVcbiAqIHN0YXR1cyBhbmQgdGhlcmVmb3JlIGNhbm5vdCBiZSBhIHByaW50L3N0YXR1cy13cml0ZSBzdGFsZSBndWFyZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoTGl2ZU9yZGVyU3RhdHVzKFxuICBraW5kOiBcImludm9pY2VcIiB8IFwicXVvdGVcIixcbiAgb3JkZXJJZDogc3RyaW5nLFxuICBjbGllbnQ6IExpdmVPcmRlclF1ZXJ5Q2xpZW50ID0gZ2V0UHJpbnRhdm9DbGllbnQoKSxcbik6IFByb21pc2U8TGl2ZU9yZGVyU3RhdHVzIHwgbnVsbD4ge1xuICBjb25zdCBkYXRhID0gYXdhaXQgY2xpZW50LnF1ZXJ5PFNpbmdsZU9yZGVyU3RhdHVzPihcbiAgICBzaW5nbGVPcmRlclN0YXR1c1F1ZXJ5KGtpbmQsIG9yZGVySWQpLFxuICApO1xuICBjb25zdCBub2RlID0gZGF0YVtraW5kXSA/PyBudWxsO1xuICBpZiAoIW5vZGUpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIG9yZGVySWQ6IG5vZGUuaWQsXG4gICAgdmlzdWFsSWQ6IG5vcm1hbGl6ZVZpc3VhbElkKG5vZGUudmlzdWFsSWQpLFxuICAgIHN0YXR1c0lkOiBub2RlLnN0YXR1cz8uaWQgPz8gbnVsbCxcbiAgICBzdGF0dXNOYW1lOiBub2RlLnN0YXR1cz8ubmFtZSA/PyBudWxsLFxuICB9O1xufVxuXG4vKiogRXhhY3QgaWRlbnRpdHkgKyBzb3VyY2Utc3RhdHVzIGZlbmNlIHVzZWQgaW1tZWRpYXRlbHkgYmVmb3JlIHNpZGUgZWZmZWN0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXZlT3JkZXJTdGF0dXNNYXRjaGVzKFxuICBvYnNlcnZlZDogTGl2ZU9yZGVyU3RhdHVzIHwgbnVsbCxcbiAgZXhwZWN0ZWQ6IHsgb3JkZXJJZDogc3RyaW5nOyB2aXN1YWxJZDogbnVtYmVyOyBzb3VyY2VTdGF0dXNJZDogc3RyaW5nIH0sXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBvYnNlcnZlZCAhPT0gbnVsbCAmJlxuICAgIG9ic2VydmVkLm9yZGVySWQgPT09IGV4cGVjdGVkLm9yZGVySWQgJiZcbiAgICBvYnNlcnZlZC52aXN1YWxJZCA9PT0gZXhwZWN0ZWQudmlzdWFsSWQgJiZcbiAgICBvYnNlcnZlZC5zdGF0dXNJZCA9PT0gZXhwZWN0ZWQuc291cmNlU3RhdHVzSWRcbiAgKTtcbn1cblxuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG59XG5cbmZ1bmN0aW9uIGlzVW5zdXBwb3J0ZWRTdGF0dXNGaWx0ZXIoZXJyOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyKS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gKFxuICAgIG1lc3NhZ2UuaW5jbHVkZXMoXCJzdGF0dXNpZHNcIikgJiZcbiAgICAobWVzc2FnZS5pbmNsdWRlcyhcInVua25vd24gYXJndW1lbnRcIikgfHxcbiAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoXCJhcmd1bWVudFwiKSB8fFxuICAgICAgbWVzc2FnZS5pbmNsdWRlcyhcImZpZWxkXCIpIHx8XG4gICAgICBtZXNzYWdlLmluY2x1ZGVzKFwiY2Fubm90IHF1ZXJ5XCIpKVxuICApO1xufVxuXG5mdW5jdGlvbiB1bnN1cHBvcnRlZEZpbHRlckVycm9yKGVycjogdW5rbm93bik6IExpdmVEaXNjb3ZlcnlFcnJvciB7XG4gIHJldHVybiBuZXcgTGl2ZURpc2NvdmVyeUVycm9yKFxuICAgIFtcbiAgICAgIFwiUHJpbnRhdm8gZG9lcyBub3Qgc3VwcG9ydCBzdGF0dXMtc2NvcGVkIGxpdmUgZGlzY292ZXJ5IChzdGF0dXNJZHMpXCIsXG4gICAgICBcImZvciB0aGlzIGFjY291bnQvc2NoZW1hOyBhdXRvLXByaW50IHdhcyBhYm9ydGVkIGJlZm9yZSBhbnkgZmFsbGJhY2tcIixcbiAgICAgIFwiY3Jhd2wuIFZlcmlmeSB0aGUgdjIgc2NoZW1hIG9yIGFkZCBhIHN1cHBvcnRlZCBzdGF0dXMgZmlsdGVyIGJlZm9yZVwiLFxuICAgICAgXCJ1c2luZyBhbiBleHBlbnNpdmUgaGlzdG9yaWNhbCB3b3JrYXJvdW5kLiBVcHN0cmVhbSBlcnJvcjpcIixcbiAgICAgIGVycm9yTWVzc2FnZShlcnIpLFxuICAgIF0uam9pbihcIiBcIiksXG4gICAgXCJ1bnN1cHBvcnRlZF9maWx0ZXJcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gaW52YWxpZFJlc3BvbnNlKFxuICBraW5kOiBPcmRlcktpbmQsXG4gIHBhZ2U6IG51bWJlcixcbiAgcmVhc29uOiBzdHJpbmcsXG4pOiBMaXZlRGlzY292ZXJ5RXJyb3Ige1xuICByZXR1cm4gbmV3IExpdmVEaXNjb3ZlcnlFcnJvcihcbiAgICBgTGl2ZSBhdXRvLXByaW50IGRpc2NvdmVyeSByZXR1cm5lZCBhbiBpbnZhbGlkICR7a2luZH0gcGFnZSAke3BhZ2V9OiAke3JlYXNvbn1gLFxuICAgIFwiaW52YWxpZF9yZXNwb25zZVwiLFxuICApO1xufVxuXG5mdW5jdGlvbiByZWFkQ29ubmVjdGlvbihcbiAga2luZDogT3JkZXJLaW5kLFxuICBkYXRhOiB1bmtub3duLFxuICBwYWdlOiBudW1iZXIsXG4pOiBDb25uZWN0aW9uPFB2T3JkZXJOb2RlPiB7XG4gIGNvbnN0IGtleSA9IGtpbmQgPT09IFwiaW52b2ljZXNcIiA/IFwiaW52b2ljZXNcIiA6IFwicXVvdGVzXCI7XG4gIGNvbnN0IGNvbm5lY3Rpb24gPSAoZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgfCB1bmRlZmluZWQpPy5ba2V5XTtcbiAgaWYgKCFjb25uZWN0aW9uIHx8IHR5cGVvZiBjb25uZWN0aW9uICE9PSBcIm9iamVjdFwiKSB7XG4gICAgdGhyb3cgaW52YWxpZFJlc3BvbnNlKGtpbmQsIHBhZ2UsIGBtaXNzaW5nICR7a2V5fSBjb25uZWN0aW9uYCk7XG4gIH1cbiAgY29uc3QgdmFsdWUgPSBjb25uZWN0aW9uIGFzIHtcbiAgICBub2Rlcz86IHVua25vd247XG4gICAgcGFnZUluZm8/OiB7IGhhc05leHRQYWdlPzogdW5rbm93bjsgZW5kQ3Vyc29yPzogdW5rbm93biB9O1xuICB9O1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUubm9kZXMpKSB7XG4gICAgdGhyb3cgaW52YWxpZFJlc3BvbnNlKGtpbmQsIHBhZ2UsIFwibm9kZXMgaXMgbm90IGFuIGFycmF5XCIpO1xuICB9XG4gIGlmIChcbiAgICAhdmFsdWUucGFnZUluZm8gfHxcbiAgICB0eXBlb2YgdmFsdWUucGFnZUluZm8uaGFzTmV4dFBhZ2UgIT09IFwiYm9vbGVhblwiIHx8XG4gICAgKHZhbHVlLnBhZ2VJbmZvLmVuZEN1cnNvciAhPT0gbnVsbCAmJlxuICAgICAgdHlwZW9mIHZhbHVlLnBhZ2VJbmZvLmVuZEN1cnNvciAhPT0gXCJzdHJpbmdcIilcbiAgKSB7XG4gICAgdGhyb3cgaW52YWxpZFJlc3BvbnNlKGtpbmQsIHBhZ2UsIFwicGFnZUluZm8gaXMgaW5jb21wbGV0ZVwiKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgQ29ubmVjdGlvbjxQdk9yZGVyTm9kZT47XG59XG5cbi8qKlxuICogUmVhZCBldmVyeSBwYWdlIG9mIGludm9pY2VzIGFuZCBxdW90ZXMgdGhhdCBQcmludGF2byBzYXlzIGN1cnJlbnRseSBoYXNcbiAqIG9uZSBvZiB0aGUgY29uZmlndXJlZCBzb3VyY2Ugc3RhdHVzZXMuIFRoZXJlIGlzIGludGVudGlvbmFsbHkgbm8gY3JlYXRlZC1hdFxuICogY3V0b2ZmLCB2aXN1YWwtaWQgY3V0b2ZmLCBvciBlYXJseS1zdG9wIGhldXJpc3RpYyBoZXJlOiBhIHN0YXR1cyB0cmFuc2l0aW9uXG4gKiBvbiBhbiBvbGQgaW52b2ljZSBtdXN0IGJlIGRpc2NvdmVyYWJsZSBvbiB0aGUgZmlyc3QgcnVuLlxuICpcbiAqIGBzdGF0dXNJZHNgIGlzIHN1cHBvcnRlZCBieSB0aGUgbGl2ZSB2MiBzY2hlbWEgb24gYm90aCByb290IGNvbm5lY3Rpb25zXG4gKiAodmVyaWZpZWQgd2l0aCByZWFkLW9ubHkgaW50cm9zcGVjdGlvbikuIElmIHRoYXQgY2FwYWJpbGl0eSBkaXNhcHBlYXJzLFxuICogdGhpcyBmdW5jdGlvbiBmYWlscyBjbG9zZWQgYW5kIGRvZXMgbm90IGZhbGwgYmFjayB0byBhIGZ1bGwgaGlzdG9yaWNhbFxuICogY3Jhd2wuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjb3ZlckxpdmVBdXRvUHJpbnRPcmRlcnMoXG4gIHN0YXR1c0lkczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGNsaWVudDogTGl2ZU9yZGVyUXVlcnlDbGllbnQgPSBnZXRQcmludGF2b0NsaWVudCgpLFxuKTogUHJvbWlzZTxMaXZlRGlzY292ZXJ5UmVzdWx0PiB7XG4gIGNvbnN0IHdhbnRlZFN0YXR1c2VzID0gbmV3IFNldChcbiAgICBzdGF0dXNJZHMuZmlsdGVyKChzdGF0dXNJZCkgPT4gc3RhdHVzSWQudHJpbSgpLmxlbmd0aCA+IDApLFxuICApO1xuICBpZiAod2FudGVkU3RhdHVzZXMuc2l6ZSA9PT0gMCkge1xuICAgIHRocm93IG5ldyBMaXZlRGlzY292ZXJ5RXJyb3IoXG4gICAgICBcIkxpdmUgYXV0by1wcmludCBkaXNjb3ZlcnkgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIHNvdXJjZSBzdGF0dXNcIixcbiAgICAgIFwiaW52YWxpZF9yZXNwb25zZVwiLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBieVZpc3VhbCA9IG5ldyBNYXA8bnVtYmVyLCBMaXZlQXV0b1ByaW50T3JkZXI+KCk7XG4gIGNvbnN0IHBhZ2VzOiBSZWNvcmQ8XCJpbnZvaWNlc1wiIHwgXCJxdW90ZXNcIiwgbnVtYmVyPiA9IHtcbiAgICBpbnZvaWNlczogMCxcbiAgICBxdW90ZXM6IDAsXG4gIH07XG5cbiAgZm9yIChjb25zdCBraW5kIG9mIFtcImludm9pY2VzXCIsIFwicXVvdGVzXCJdIGFzIGNvbnN0KSB7XG4gICAgbGV0IGN1cnNvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgY29uc3Qgc2VlbkN1cnNvcnMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCBwYWdlTnVtYmVyID0gcGFnZXNba2luZF0gKyAxO1xuICAgICAgbGV0IGRhdGE6IEludm9pY2VzUGFnZSB8IFF1b3Rlc1BhZ2U7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBxdWVyeSA9XG4gICAgICAgICAga2luZCA9PT0gXCJpbnZvaWNlc1wiXG4gICAgICAgICAgICA/IGludm9pY2VzUGFnZVF1ZXJ5KHtcbiAgICAgICAgICAgICAgICBhZnRlcjogY3Vyc29yLFxuICAgICAgICAgICAgICAgIHN0YXR1c0lkczogWy4uLndhbnRlZFN0YXR1c2VzXSxcbiAgICAgICAgICAgICAgICBzb3J0RGVzY2VuZGluZzogZmFsc2UsXG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICA6IHF1b3Rlc1BhZ2VRdWVyeSh7XG4gICAgICAgICAgICAgICAgYWZ0ZXI6IGN1cnNvcixcbiAgICAgICAgICAgICAgICBzdGF0dXNJZHM6IFsuLi53YW50ZWRTdGF0dXNlc10sXG4gICAgICAgICAgICAgICAgc29ydERlc2NlbmRpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgZGF0YSA9IGF3YWl0IGNsaWVudC5xdWVyeTxJbnZvaWNlc1BhZ2UgfCBRdW90ZXNQYWdlPihxdWVyeSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzVW5zdXBwb3J0ZWRTdGF0dXNGaWx0ZXIoZXJyKSkge1xuICAgICAgICAgIHRocm93IHVuc3VwcG9ydGVkRmlsdGVyRXJyb3IoZXJyKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBuZXcgTGl2ZURpc2NvdmVyeUVycm9yKFxuICAgICAgICAgIGBMaXZlIGF1dG8tcHJpbnQgZGlzY292ZXJ5IGZhaWxlZCBvbiAke2tpbmR9IHBhZ2UgJHtwYWdlTnVtYmVyfTogJHtlcnJvck1lc3NhZ2UoZXJyKX1gLFxuICAgICAgICAgIFwicmVxdWVzdFwiLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBwYWdlID0gcmVhZENvbm5lY3Rpb24oa2luZCwgZGF0YSwgcGFnZU51bWJlcik7XG4gICAgICBwYWdlc1traW5kXSA9IHBhZ2VOdW1iZXI7XG4gICAgICBmb3IgKGNvbnN0IHJhd05vZGUgb2YgcGFnZS5ub2Rlcykge1xuICAgICAgICBpZiAoIXJhd05vZGUgfHwgdHlwZW9mIHJhd05vZGUgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICB0aHJvdyBpbnZhbGlkUmVzcG9uc2Uoa2luZCwgcGFnZU51bWJlciwgXCJhIG5vZGUgaXMgbm90IGFuIG9iamVjdFwiKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub2RlID0gcmF3Tm9kZSBhcyBQdk9yZGVyTm9kZTtcbiAgICAgICAgaWYgKHR5cGVvZiBub2RlLmlkICE9PSBcInN0cmluZ1wiIHx8IG5vZGUuaWQubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgdGhyb3cgaW52YWxpZFJlc3BvbnNlKGtpbmQsIHBhZ2VOdW1iZXIsIFwiYSBub2RlIGhhcyBubyBpZFwiKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBQcmludGF2bydzIEdyYXBoUUwgc2NhbGFyIGhhcyByZXR1cm5lZCB2aXN1YWxJZCBhcyBib3RoIGEgbnVtYmVyXG4gICAgICAgIC8vIGFuZCBhIG51bWVyaWMgc3RyaW5nIGFjcm9zcyBhY2NvdW50cy9yZXBsaWNhcy4gTm9ybWFsaXplIHRoZVxuICAgICAgICAvLyByZXNwb25zZSBiZWZvcmUgaXQgcmVhY2hlcyB0aGUgbWlycm9yIGFuZCBkZWR1cGUgbG9naWMuXG4gICAgICAgIGNvbnN0IHZpc3VhbElkID0gbm9ybWFsaXplVmlzdWFsSWQoXG4gICAgICAgICAgKG5vZGUgYXMgdW5rbm93biBhcyB7IHZpc3VhbElkPzogdW5rbm93biB9KS52aXN1YWxJZCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHZpc3VhbElkID09PSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgaW52YWxpZFJlc3BvbnNlKFxuICAgICAgICAgICAga2luZCxcbiAgICAgICAgICAgIHBhZ2VOdW1iZXIsXG4gICAgICAgICAgICBgb3JkZXIgJHtub2RlLmlkfSBoYXMgbm8gaW50ZWdlciB2aXN1YWxJZGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub3JtYWxpemVkTm9kZSA9IHsgLi4ubm9kZSwgdmlzdWFsSWQgfTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICFub2RlLnN0YXR1cyB8fFxuICAgICAgICAgIHR5cGVvZiBub2RlLnN0YXR1cy5pZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgICF3YW50ZWRTdGF0dXNlcy5oYXMobm9kZS5zdGF0dXMuaWQpXG4gICAgICAgICkge1xuICAgICAgICAgIC8vIERvIG5vdCB0cnVzdCBhbiBBUEkgcmVzcG9uc2UgdGhhdCBpZ25vcmVzIHRoZSBzdGF0dXNJZHMgYXJndW1lbnQ6XG4gICAgICAgICAgLy8gYWNjZXB0aW5nIGl0IHdvdWxkIHJlaW50cm9kdWNlIHRoZSBzdGFsZS1sb2NhbC1zdGF0dXMgYnVnLlxuICAgICAgICAgIHRocm93IGludmFsaWRSZXNwb25zZShcbiAgICAgICAgICAgIGtpbmQsXG4gICAgICAgICAgICBwYWdlTnVtYmVyLFxuICAgICAgICAgICAgYG9yZGVyICR7bm9kZS5pZH0gZGlkIG5vdCBtYXRjaCB0aGUgcmVxdWVzdGVkIHN0YXR1c0lkc2AsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYnlWaXN1YWwuZ2V0KHZpc3VhbElkKTtcbiAgICAgICAgLy8gQSBxdW90ZSBjYW4gY29leGlzdCBicmllZmx5IHdpdGggaXRzIGludm9pY2UgZHVyaW5nIGNvbnZlcnNpb24uIFRoZVxuICAgICAgICAvLyBpbnZvaWNlIGlzIHRoZSBwcmludGFibGUvbGl2ZSB3aW5uZXI7IHByZXNlcnZpbmcgb25lIHZpc3VhbCBpZCBoZXJlXG4gICAgICAgIC8vIGFsc28gcHJldmVudHMgdHdvIHN1Ym1pc3Npb25zIGluIG9uZSBydW4uXG4gICAgICAgIGlmICghZXhpc3RpbmcgfHwgKGV4aXN0aW5nLmtpbmQgPT09IFwicXVvdGVzXCIgJiYga2luZCA9PT0gXCJpbnZvaWNlc1wiKSkge1xuICAgICAgICAgIGJ5VmlzdWFsLnNldCh2aXN1YWxJZCwgeyBraW5kLCBub2RlOiBub3JtYWxpemVkTm9kZSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoIXBhZ2UucGFnZUluZm8uaGFzTmV4dFBhZ2UpIGJyZWFrO1xuICAgICAgY29uc3QgbmV4dEN1cnNvciA9IHBhZ2UucGFnZUluZm8uZW5kQ3Vyc29yO1xuICAgICAgaWYgKCFuZXh0Q3Vyc29yKSB7XG4gICAgICAgIHRocm93IG5ldyBMaXZlRGlzY292ZXJ5RXJyb3IoXG4gICAgICAgICAgYExpdmUgYXV0by1wcmludCBkaXNjb3Zlcnkgd2FzIGluY29tcGxldGU6ICR7a2luZH0gcGFnZSAke3BhZ2VOdW1iZXJ9IHJlcG9ydGVkIGhhc05leHRQYWdlIHdpdGhvdXQgYW4gZW5kQ3Vyc29yYCxcbiAgICAgICAgICBcImluY29tcGxldGVfcGFnaW5hdGlvblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKG5leHRDdXJzb3IgPT09IGN1cnNvcikge1xuICAgICAgICB0aHJvdyBuZXcgTGl2ZURpc2NvdmVyeUVycm9yKFxuICAgICAgICAgIGBMaXZlIGF1dG8tcHJpbnQgZGlzY292ZXJ5IHdhcyBpbmNvbXBsZXRlOiAke2tpbmR9IHBhZ2UgJHtwYWdlTnVtYmVyfSByZXBlYXRlZCBpdHMgY3Vyc29yYCxcbiAgICAgICAgICBcImluY29tcGxldGVfcGFnaW5hdGlvblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHNlZW5DdXJzb3JzLmhhcyhuZXh0Q3Vyc29yKSkge1xuICAgICAgICB0aHJvdyBuZXcgTGl2ZURpc2NvdmVyeUVycm9yKFxuICAgICAgICAgIGBMaXZlIGF1dG8tcHJpbnQgZGlzY292ZXJ5IHdhcyBpbmNvbXBsZXRlOiAke2tpbmR9IHBhZ2luYXRpb24gY3Vyc29yIGN5Y2xlIGRldGVjdGVkIGF0ICR7bmV4dEN1cnNvcn1gLFxuICAgICAgICAgIFwiaW5jb21wbGV0ZV9wYWdpbmF0aW9uXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBzZWVuQ3Vyc29ycy5hZGQobmV4dEN1cnNvcik7XG4gICAgICBjdXJzb3IgPSBuZXh0Q3Vyc29yO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb3JkZXJzOiBbLi4uYnlWaXN1YWwudmFsdWVzKCldLnNvcnQoXG4gICAgICAoYSwgYikgPT4gYS5ub2RlLnZpc3VhbElkIC0gYi5ub2RlLnZpc3VhbElkLFxuICAgICksXG4gICAgcGFnZXMsXG4gIH07XG59IiwgIi8qKiBTY2hlZHVsZXItb25seSBzYWZldHkgZ2F0ZTsgbWFudWFsIHN0YXJ0cyByZW1haW4gZXhwbGljaXQgb3BlcmF0b3IgYWN0aW9ucy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2hlZHVsZWRBdXRvUHJpbnRBbGxvd2VkKFxuICBkcnlSdW46IGJvb2xlYW4sXG4gIG5vZGVFbnYgPSBwcm9jZXNzLmVudi5OT0RFX0VOVixcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gbm9kZUVudiAhPT0gXCJkZXZlbG9wbWVudFwiIHx8IGRyeVJ1bjtcbn0iLCAiLyoqIEludGVybmFsIHJlcGxhY2VtZW50IG9yZGVycyBzdGlsbCBiZWxvbmcgb24gUE9zLCBidXQgbmVlZCBubyB3b3Jrb3JkZXIgb3IgUE8gYXR0YWNobWVudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0ludGVybmFsUmVwbGFjZW1lbnRJbnZvaWNlKHZpc3VhbElkOiBudW1iZXIgfCBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIHJldHVybiBOdW1iZXIodmlzdWFsSWQpID09PSAyMjc4Nztcbn1cblxudHlwZSBBdHRhY2htZW50TGluZSA9IHtcbiAgcHJpbnRhdm9PcmRlcklkOiBzdHJpbmcgfCBudWxsO1xuICB2aXN1YWxJZDogbnVtYmVyIHwgbnVsbDtcbiAgc3RhdHVzOiBzdHJpbmc7XG59O1xuXG4vKiogRmlsdGVyIG9ubHkgYXR0YWNobWVudCBkZXN0aW5hdGlvbnM7IG5ldmVyIG11dGF0ZSBvciBmaWx0ZXIgdGhlIFBPJ3Mgb3duIGxpbmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBvQXR0YWNobWVudFRhcmdldHMoXG4gIGxpbmVzOiByZWFkb25seSBBdHRhY2htZW50TGluZVtdLFxuICBhdHRhY2hlZEludm9pY2VJZHM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBrbm93bk9yZGVyczogcmVhZG9ubHkgeyBpZDogc3RyaW5nOyB2aXN1YWxJZDogbnVtYmVyIHwgbnVsbCB9W10sXG4pOiBNYXA8c3RyaW5nLCBudW1iZXIgfCBudWxsPiB7XG4gIGNvbnN0IGV4Y2x1ZGVkSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnByaW50YXZvT3JkZXJJZCAmJiBpc0ludGVybmFsUmVwbGFjZW1lbnRJbnZvaWNlKGxpbmUudmlzdWFsSWQpKSBleGNsdWRlZElkcy5hZGQobGluZS5wcmludGF2b09yZGVySWQpO1xuICB9XG4gIGZvciAoY29uc3Qgb3JkZXIgb2Yga25vd25PcmRlcnMpIHtcbiAgICBpZiAoaXNJbnRlcm5hbFJlcGxhY2VtZW50SW52b2ljZShvcmRlci52aXN1YWxJZCkpIGV4Y2x1ZGVkSWRzLmFkZChvcmRlci5pZCk7XG4gIH1cbiAgY29uc3QgdGFyZ2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXIgfCBudWxsPigpO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBpZiAoXG4gICAgICBsaW5lLnByaW50YXZvT3JkZXJJZCAmJiAhZXhjbHVkZWRJZHMuaGFzKGxpbmUucHJpbnRhdm9PcmRlcklkKSAmJlxuICAgICAgIWF0dGFjaGVkSW52b2ljZUlkcy5pbmNsdWRlcyhsaW5lLnByaW50YXZvT3JkZXJJZCkgJiZcbiAgICAgIChsaW5lLnN0YXR1cyA9PT0gXCJkb25lXCIgfHwgbGluZS5zdGF0dXMgPT09IFwic2tpcHBlZF9vcmRlcmVkXCIpICYmXG4gICAgICAhdGFyZ2V0cy5oYXMobGluZS5wcmludGF2b09yZGVySWQpXG4gICAgKSB0YXJnZXRzLnNldChsaW5lLnByaW50YXZvT3JkZXJJZCwgbGluZS52aXN1YWxJZCk7XG4gIH1cbiAgcmV0dXJuIHRhcmdldHM7XG59IiwgImltcG9ydCB7XG4gIGxpdmVPcmRlclN0YXR1c01hdGNoZXMsXG4gIHR5cGUgTGl2ZU9yZGVyU3RhdHVzLFxufSBmcm9tIFwiLi9saXZlRGlzY292ZXJ5XCI7XG5pbXBvcnQgeyBpc0ludGVybmFsUmVwbGFjZW1lbnRJbnZvaWNlIH0gZnJvbSBcIi4uLy4uL3B1cmNoYXNpbmcvaW50ZXJuYWxJbnZvaWNlUG9saWN5XCI7XG5cbmV4cG9ydCBjb25zdCBJTlRFUk5BTF9SRVBMQUNFTUVOVF9XT1JLT1JERVJfU0tJUF9SRUFTT04gPVxuICBcImludGVybmFsX3JlcGxhY2VtZW50c19pbnZvaWNlX25vX3dvcmtvcmRlclwiO1xuXG4vKiogUGFydGl0aW9uIGJlZm9yZSBhcHBseWluZyB0aGUgcGVyLXJ1biBjYXAgc28gdGhlIGludGVybmFsIGludm9pY2UgY2Fubm90IHRha2UgYSBzbG90LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdEF1dG9QcmludFdvcmtvcmRlcnM8VD4oXG4gIHByaW9yaXRpemVkOiByZWFkb25seSBUW10sXG4gIGxpbWl0OiBudW1iZXIsXG4gIHZpc3VhbElkT2Y6IChvcmRlcjogVCkgPT4gbnVtYmVyIHwgc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IHsgc2VsZWN0ZWQ6IFRbXTsgZXhjbHVkZWQ6IFRbXTsgZGVmZXJyZWQ6IFRbXSB9IHtcbiAgY29uc3QgZWxpZ2libGU6IFRbXSA9IFtdO1xuICBjb25zdCBleGNsdWRlZDogVFtdID0gW107XG4gIGZvciAoY29uc3Qgb3JkZXIgb2YgcHJpb3JpdGl6ZWQpIHtcbiAgICAoaXNJbnRlcm5hbFJlcGxhY2VtZW50SW52b2ljZSh2aXN1YWxJZE9mKG9yZGVyKSkgPyBleGNsdWRlZCA6IGVsaWdpYmxlKS5wdXNoKG9yZGVyKTtcbiAgfVxuICByZXR1cm4geyBzZWxlY3RlZDogZWxpZ2libGUuc2xpY2UoMCwgbGltaXQpLCBleGNsdWRlZCwgZGVmZXJyZWQ6IGVsaWdpYmxlLnNsaWNlKGxpbWl0KSB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFByaW50U2FmZXR5Q2hlY2sge1xuICBkcnlSdW46IGJvb2xlYW47XG4gIG9ic2VydmVkU3RhdHVzOiBMaXZlT3JkZXJTdGF0dXMgfCBudWxsO1xuICBleHBlY3RlZDoge1xuICAgIG9yZGVySWQ6IHN0cmluZztcbiAgICB2aXN1YWxJZDogbnVtYmVyO1xuICAgIHNvdXJjZVN0YXR1c0lkOiBzdHJpbmc7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJpbnRTYWZldHlSZXN1bHQge1xuICBhbGxvd2VkOiBib29sZWFuO1xuICByZWFzb246IHN0cmluZyB8IG51bGw7XG59XG5cbi8qKlxuICogU2luZ2xlIHNpZGUtZWZmZWN0IGdhdGUgZm9yIFByaW50Tm9kZS4gRHJ5IHJ1bnMgbmV2ZXIgcGFzcyB0aGlzIGdhdGUsIGFuZCBhXG4gKiByZWFsIHJ1biByZXF1aXJlcyB0aGUgZXhhY3QgbGl2ZSBpZCArIHZpc3VhbCBpZCArIHNvdXJjZSBzdGF0dXMgaW1tZWRpYXRlbHlcbiAqIGJlZm9yZSBzdWJtaXNzaW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tQcmludFNhZmV0eShcbiAgaW5wdXQ6IFByaW50U2FmZXR5Q2hlY2ssXG4pOiBQcmludFNhZmV0eVJlc3VsdCB7XG4gIGlmIChpc0ludGVybmFsUmVwbGFjZW1lbnRJbnZvaWNlKGlucHV0LmV4cGVjdGVkLnZpc3VhbElkKSB8fFxuICAgICAgaXNJbnRlcm5hbFJlcGxhY2VtZW50SW52b2ljZShpbnB1dC5vYnNlcnZlZFN0YXR1cz8udmlzdWFsSWQpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFsbG93ZWQ6IGZhbHNlLFxuICAgICAgcmVhc29uOiBcIkludGVybmFsIHJlcGxhY2VtZW50cyBpbnZvaWNlICMyMjc4NyBuZWVkcyBubyBBdXRvUHJpbnQgd29ya29yZGVyXCIsXG4gICAgfTtcbiAgfVxuICBpZiAoaW5wdXQuZHJ5UnVuKSB7XG4gICAgcmV0dXJuIHsgYWxsb3dlZDogZmFsc2UsIHJlYXNvbjogXCJEcnkgcnVuIFx1MjAxNCBQcmludE5vZGUgc3VibWlzc2lvbiBkaXNhYmxlZFwiIH07XG4gIH1cbiAgaWYgKFxuICAgICFsaXZlT3JkZXJTdGF0dXNNYXRjaGVzKGlucHV0Lm9ic2VydmVkU3RhdHVzLCBpbnB1dC5leHBlY3RlZClcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFsbG93ZWQ6IGZhbHNlLFxuICAgICAgcmVhc29uOlxuICAgICAgICBcIkxpdmUgb3JkZXIgaWRlbnRpdHkvc3RhdHVzIGNoYW5nZWQgb3IgY291bGQgbm90IGJlIHZlcmlmaWVkOyBQcmludE5vZGUgc3VibWlzc2lvbiByZWZ1c2VkXCIsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBhbGxvd2VkOiB0cnVlLCByZWFzb246IG51bGwgfTtcbn0iLCAiaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG4vKiogV2hpdGVsaXN0ZWQgcHJvZHVjdCBmaWVsZHMgb25seTogc3RhdHVzLCBvcmRlcmVkIGZsYWdzIGFuZCB0aW1lc3RhbXBzIG5ldmVyIGFmZmVjdCB0aGlzIGJhc2VsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpbmVJdGVtRmluZ2VycHJpbnQobGluZXM6IHJlYWRvbmx5IFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pOiBzdHJpbmcge1xuICBjb25zdCBjYW5vbmljYWwgPSAodmFsdWU6IHVua25vd24pOiB1bmtub3duID0+IHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5tYXAoY2Fub25pY2FsKS5zb3J0KChhLCBiKSA9PiBKU09OLnN0cmluZ2lmeShhKS5sb2NhbGVDb21wYXJlKEpTT04uc3RyaW5naWZ5KGIpKSk7XG4gICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyh2YWx1ZSkuc29ydCgoW2FdLCBbYl0pID0+IGEubG9jYWxlQ29tcGFyZShiKSkubWFwKChbaywgdl0pID0+IFtrLCBjYW5vbmljYWwodildKSk7XG4gICAgcmV0dXJuIHZhbHVlID8/IG51bGw7XG4gIH07XG4gIGNvbnN0IHByb2R1Y3RzID0gbGluZXMubWFwKChsaW5lKSA9PiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgW1wiaWRcIiwgXCJpdGVtTnVtYmVyXCIsIFwiY29sb3JcIiwgXCJkZXNjcmlwdGlvblwiLCBcIml0ZW1zXCIsIFwic2l6ZXNcIiwgXCJwcm9kdWN0XCIsIFwiY2F0ZWdvcnlcIiwgXCJwcmljZVwiLCBcIm1lcmNoXCJdXG4gICAgICAubWFwKChrZXkpID0+IFtrZXksIGxpbmVba2V5XSA/PyBudWxsXSksXG4gICkpO1xuICByZXR1cm4gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoSlNPTi5zdHJpbmdpZnkoY2Fub25pY2FsKHByb2R1Y3RzKSkpLmRpZ2VzdChcImhleFwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlY2lkZVJlcHJpbnQoaW5wdXQ6IHtcbiAgcHJpb3I6IHsgY29udGVudEZpbmdlcnByaW50OiBzdHJpbmcgfCBudWxsOyBwcmludGVkQXQ6IERhdGUgfCBudWxsIH0gfCBudWxsO1xuICBmaW5nZXJwcmludDogc3RyaW5nO1xuICByZWVudHJ5OiB7IGlkOiBudW1iZXI7IG9jY3VycmVkQXQ6IERhdGUgfSB8IG51bGw7XG59KTogeyBhbGxvd2VkOiBib29sZWFuOyBpc1JlcHJpbnQ6IGJvb2xlYW47IHJlYXNvbjogc3RyaW5nIHwgbnVsbDsgY3ljbGU6IHN0cmluZyB9IHtcbiAgY29uc3QgeyBwcmlvciwgZmluZ2VycHJpbnQsIHJlZW50cnkgfSA9IGlucHV0O1xuICBpZiAoIXByaW9yKSByZXR1cm4geyBhbGxvd2VkOiB0cnVlLCBpc1JlcHJpbnQ6IGZhbHNlLCByZWFzb246IG51bGwsIGN5Y2xlOiBcImluaXRpYWxcIiB9O1xuICBjb25zdCBkZW55ID0gKHJlYXNvbjogc3RyaW5nKSA9PiAoeyBhbGxvd2VkOiBmYWxzZSwgaXNSZXByaW50OiBmYWxzZSwgcmVhc29uLCBjeWNsZTogXCJibG9ja2VkXCIgfSk7XG4gIGlmICghcHJpb3IuY29udGVudEZpbmdlcnByaW50IHx8ICFwcmlvci5wcmludGVkQXQpIHJldHVybiBkZW55KFwicHJpb3JfcHJpbnRfYmFzZWxpbmVfbWlzc2luZ1wiKTtcbiAgaWYgKCFyZWVudHJ5IHx8IHJlZW50cnkub2NjdXJyZWRBdCA8PSBwcmlvci5wcmludGVkQXQpIHJldHVybiBkZW55KFwibm9fc291cmNlX3JlZW50cnlfYWZ0ZXJfcHJpbnRcIik7XG4gIGlmIChmaW5nZXJwcmludCA9PT0gcHJpb3IuY29udGVudEZpbmdlcnByaW50KSByZXR1cm4gZGVueShcImxpbmVfaXRlbXNfdW5jaGFuZ2VkXCIpO1xuICByZXR1cm4geyBhbGxvd2VkOiB0cnVlLCBpc1JlcHJpbnQ6IHRydWUsIHJlYXNvbjogbnVsbCwgY3ljbGU6IGBlbnRyeToke3JlZW50cnkuaWR9YCB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJpbnRBdHRlbXB0S2V5KGxvZ2ljYWxPcmRlcjogc3RyaW5nLCBjeWNsZTogc3RyaW5nLCBmaW5nZXJwcmludDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKEpTT04uc3RyaW5naWZ5KFtsb2dpY2FsT3JkZXIsIGN5Y2xlLCBmaW5nZXJwcmludF0pKS5kaWdlc3QoXCJoZXhcIik7XG59XG5cbi8qKiBDYWxsZWQgdW5kZXIgdGhlIGRhdGFiYXNlIGxvZ2ljYWwtb3JkZXIgbG9jaywgd2l0aCBsYXRlc3Qgc3VjY2Vzc2Z1bCBwcmludCBmaXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5SZXNlcnZlUHJpbnQoaGlzdG9yeTogcmVhZG9ubHkgeyBpZDogc3RyaW5nOyBzdGF0dXM6IHN0cmluZyB9W10sIGV4cGVjdGVkUHJpb3JJZDogc3RyaW5nIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoaGlzdG9yeS5zb21lKChyb3cpID0+IHJvdy5zdGF0dXMgPT09IFwicGVuZGluZ1wiIHx8IHJvdy5zdGF0dXMgPT09IFwic3VibWlzc2lvbl91bmtub3duXCIpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAoaGlzdG9yeS5maW5kKChyb3cpID0+IHJvdy5zdGF0dXMgPT09IFwicHJpbnRlZFwiKT8uaWQgPz8gbnVsbCkgPT09IGV4cGVjdGVkUHJpb3JJZDtcbn1cblxuLyoqIE9ubHkga25vd24gcmVjb3JkZWQgc3RhdHVzIHNoYXBlcyBhcmUgYWNjZXB0ZWQ7IGFyYml0cmFyeSBvYmplY3RzIG5ldmVyIHByb3ZlIGFuIGV4aXQuICovXG5leHBvcnQgZnVuY3Rpb24gb2JzZXJ2ZWRTb3VyY2VNZW1iZXJzaGlwKHZhbHVlOiB1bmtub3duLCBzdGF0dXNlczogcmVhZG9ubHkgeyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfVtdLCBzb3VyY2VJZHM6IFJlYWRvbmx5U2V0PHN0cmluZz4sIGRlcHRoID0gMCk6IGJvb2xlYW4gfCBudWxsIHtcbiAgaWYgKGRlcHRoID4gMyB8fCB2YWx1ZSA9PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IHRleHQgPSB2YWx1ZS50cmltKCk7XG4gICAgaWYgKCF0ZXh0KSByZXR1cm4gbnVsbDtcbiAgICBpZiAodGV4dC5zdGFydHNXaXRoKCdcIicpIHx8IHRleHQuc3RhcnRzV2l0aChcIntcIikpIHtcbiAgICAgIHRyeSB7IHJldHVybiBvYnNlcnZlZFNvdXJjZU1lbWJlcnNoaXAoSlNPTi5wYXJzZSh0ZXh0KSwgc3RhdHVzZXMsIHNvdXJjZUlkcywgZGVwdGggKyAxKTsgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XG4gICAgfVxuICAgIGNvbnN0IG1hdGNoZXMgPSBzdGF0dXNlcy5maWx0ZXIoKHMpID0+IHMuaWQgPT09IHRleHQgfHwgcy5uYW1lID09PSB0ZXh0KTtcbiAgICBjb25zdCByZXN1bHRzID0gbmV3IFNldChtYXRjaGVzLm1hcCgocykgPT4gc291cmNlSWRzLmhhcyhzLmlkKSkpO1xuICAgIHJldHVybiByZXN1bHRzLnNpemUgPT09IDEgPyBbLi4ucmVzdWx0c11bMF0gOiBudWxsO1xuICB9XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiBudWxsO1xuICBjb25zdCBvYmplY3QgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaWYgKFwic3RhdHVzXCIgaW4gb2JqZWN0KSByZXR1cm4gb2JzZXJ2ZWRTb3VyY2VNZW1iZXJzaGlwKG9iamVjdC5zdGF0dXMsIHN0YXR1c2VzLCBzb3VyY2VJZHMsIGRlcHRoICsgMSk7XG4gIGNvbnN0IGlkID0gb2JqZWN0LmlkID8/IG9iamVjdC5zdGF0dXNJZDtcbiAgY29uc3QgbmFtZSA9IG9iamVjdC5uYW1lID8/IG9iamVjdC5zdGF0dXNOYW1lO1xuICBpZiAodHlwZW9mIGlkID09PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBpZCA9PT0gXCJudW1iZXJcIikge1xuICAgIGNvbnN0IHN0YXR1cyA9IHN0YXR1c2VzLmZpbmQoKHMpID0+IHMuaWQgPT09IFN0cmluZyhpZCkpO1xuICAgIGlmICghc3RhdHVzIHx8ICh0eXBlb2YgbmFtZSA9PT0gXCJzdHJpbmdcIiAmJiBuYW1lICE9PSBzdGF0dXMubmFtZSkpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBzb3VyY2VJZHMuaGFzKHN0YXR1cy5pZCk7XG4gIH1cbiAgcmV0dXJuIHR5cGVvZiBuYW1lID09PSBcInN0cmluZ1wiID8gb2JzZXJ2ZWRTb3VyY2VNZW1iZXJzaGlwKG5hbWUsIHN0YXR1c2VzLCBzb3VyY2VJZHMsIGRlcHRoICsgMSkgOiBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbnZlcnNpb25FdmlkZW5jZSB7XG4gIGVudGl0eVR5cGU6IHN0cmluZzsgZW50aXR5SWQ6IHN0cmluZzsgZXZlbnRUeXBlOiBzdHJpbmc7IHZpc3VhbElkOiBudW1iZXIgfCBudWxsO1xuICBvbGRWYWx1ZTogdW5rbm93bjsgbmV3VmFsdWU6IHVua25vd247XG59XG5cbi8qKiBWaXN1YWwgaWRlbnRpdHkgYWxvbmUgaXMgaW5zdWZmaWNpZW50OiByZXF1aXJlIHRoZSBzeW5jIGVuZ2luZSdzIGV4cGxpY2l0IGNvbnZlcnNpb24gcHJvdmVuYW5jZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZmllZENvbnZlcnNpb25PcmRlcklkcyhvcmRlcjogQXV0b1ByaW50SWRlbnRpdHksIGV2ZW50czogcmVhZG9ubHkgQ29udmVyc2lvbkV2aWRlbmNlW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGlkcyA9IGV2ZW50cy5mbGF0TWFwKChldmVudCkgPT4ge1xuICAgIGlmIChldmVudC5lbnRpdHlUeXBlICE9PSBcIm9yZGVyXCIgfHwgZXZlbnQuZXZlbnRUeXBlICE9PSBcImNvbnZlcnRlZFwiIHx8XG4gICAgICBldmVudC5lbnRpdHlJZCAhPT0gb3JkZXIub3JkZXJJZCB8fCBldmVudC52aXN1YWxJZCAhPT0gb3JkZXIudmlzdWFsSWQpIHJldHVybiBbXTtcbiAgICBjb25zdCBvbGQgPSBldmVudC5vbGRWYWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw7XG4gICAgY29uc3QgbmV4dCA9IGV2ZW50Lm5ld1ZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbDtcbiAgICBpZiAoIW9sZCB8fCAhbmV4dCB8fCBvbGQub3JkZXJUeXBlICE9PSBcInF1b3RlXCIgfHwgbmV4dC5vcmRlclR5cGUgIT09IFwiaW52b2ljZVwiIHx8XG4gICAgICB0eXBlb2Ygb2xkLnByaW50YXZvSWQgIT09IFwic3RyaW5nXCIgfHwgbmV4dC5wcmludGF2b0lkICE9PSBvcmRlci5vcmRlcklkIHx8XG4gICAgICBvbGQucHJpbnRhdm9JZCA9PT0gb3JkZXIub3JkZXJJZCB8fCAhb2xkLmN1c3RvbWVySWQgfHwgb2xkLmN1c3RvbWVySWQgIT09IG5leHQuY3VzdG9tZXJJZCkgcmV0dXJuIFtdO1xuICAgIHJldHVybiBbb2xkLnByaW50YXZvSWRdO1xuICB9KTtcbiAgY29uc3QgdW5pcXVlID0gWy4uLm5ldyBTZXQoaWRzKV07XG4gIHJldHVybiB1bmlxdWUubGVuZ3RoID09PSAxID8gdW5pcXVlIDogW107XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBodWJQb09yZGVyc0Zyb21PdXRjb21lcyhcbiAgb3V0Y29tZXM6IHJlYWRvbmx5IHsgY2FuZGlkYXRlOiBBdXRvUHJpbnRJZGVudGl0eTsgb3V0Y29tZTogc3RyaW5nIH1bXSxcbiAgY29udmVyc2lvbnM6IHJlYWRvbmx5IENvbnZlcnNpb25FdmlkZW5jZVtdLFxuKTogKEF1dG9QcmludElkZW50aXR5ICYgeyB2ZXJpZmllZFNuYXBzaG90T3JkZXJJZHM6IHN0cmluZ1tdIH0pW10ge1xuICByZXR1cm4gb3V0Y29tZXMuZmlsdGVyKChvKSA9PiBvLm91dGNvbWUgPT09IFwicHJpbnRlZFwiKS5tYXAoKHsgY2FuZGlkYXRlIH0pID0+ICh7XG4gICAgb3JkZXJJZDogY2FuZGlkYXRlLm9yZGVySWQsIHZpc3VhbElkOiBjYW5kaWRhdGUudmlzdWFsSWQsXG4gICAgdmVyaWZpZWRTbmFwc2hvdE9yZGVySWRzOiB2ZXJpZmllZENvbnZlcnNpb25PcmRlcklkcyhjYW5kaWRhdGUsIGNvbnZlcnNpb25zKSxcbiAgfSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVmaW5pdGl2ZUZhaWx1cmVDYW5kaWRhdGVzPFQ+KG91dGNvbWVzOiByZWFkb25seSB7IGNhbmRpZGF0ZTogVDsgb3V0Y29tZTogc3RyaW5nOyBkZWZpbml0aXZlUHJlU3VibWl0RmFpbHVyZT86IGJvb2xlYW4gfVtdKTogVFtdIHtcbiAgcmV0dXJuIG91dGNvbWVzLmZpbHRlcigobykgPT4gby5vdXRjb21lID09PSBcImZhaWxlZFwiICYmIG8uZGVmaW5pdGl2ZVByZVN1Ym1pdEZhaWx1cmUgPT09IHRydWUpLm1hcCgobykgPT4gby5jYW5kaWRhdGUpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9QcmludElkZW50aXR5IHtcbiAgb3JkZXJJZDogc3RyaW5nO1xuICB2aXN1YWxJZDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9QcmludENhbmRpZGF0ZVBsYW48VD4ge1xuICBzZWxlY3RlZDogVFtdO1xuICBhbHJlYWR5UHJpbnRlZDogbnVtYmVyO1xuICBkZWZlcnJlZDogbnVtYmVyO1xufVxuXG4vKipcbiAqIEhpc3RvcnkgZGVkdXAgYW5kIHRoZSBwZXItcnVuIGRldGFpbCBjYXAgZGVsaWJlcmF0ZWx5IGhhcHBlbiBiZWZvcmUgYW55XG4gKiBkZXRhaWwgZmV0Y2guIEtlZXBpbmcgdGhpcyBwdXJlIG1ha2VzIHRoZSBleHBlbnNpdmUtd29yayBvcmRlcmluZ1xuICogZXhlY3V0YWJsZSBpbiBmb2N1c2VkIHRlc3RzIHdpdGhvdXQgdG91Y2hpbmcgUHJpbnROb2RlIG9yIHRoZSBkYXRhYmFzZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYW5BdXRvUHJpbnREZXRhaWxzPFQ+KFxuICBvcmRlcnM6IHJlYWRvbmx5IFRbXSxcbiAgaWRlbnRpdHlPZjogKG9yZGVyOiBUKSA9PiBBdXRvUHJpbnRJZGVudGl0eSxcbiAgcHJpbnRlZElkczogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbiAgcHJpbnRlZFZpc3VhbHM6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gIG1heE9yZGVyczogbnVtYmVyLFxuKTogQXV0b1ByaW50Q2FuZGlkYXRlUGxhbjxUPiB7XG4gIGNvbnN0IHVucHJpbnRlZDogVFtdID0gW107XG4gIGxldCBhbHJlYWR5UHJpbnRlZCA9IDA7XG4gIGZvciAoY29uc3Qgb3JkZXIgb2Ygb3JkZXJzKSB7XG4gICAgY29uc3QgaWRlbnRpdHkgPSBpZGVudGl0eU9mKG9yZGVyKTtcbiAgICBpZiAoXG4gICAgICBwcmludGVkSWRzLmhhcyhpZGVudGl0eS5vcmRlcklkKSB8fFxuICAgICAgcHJpbnRlZFZpc3VhbHMuaGFzKFN0cmluZyhpZGVudGl0eS52aXN1YWxJZCkpXG4gICAgKSB7XG4gICAgICBhbHJlYWR5UHJpbnRlZCArPSAxO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHVucHJpbnRlZC5wdXNoKG9yZGVyKTtcbiAgfVxuICBjb25zdCBzZWxlY3RlZCA9IHVucHJpbnRlZC5zbGljZSgwLCBNYXRoLm1heCgwLCBtYXhPcmRlcnMpKTtcbiAgcmV0dXJuIHtcbiAgICBzZWxlY3RlZCxcbiAgICBhbHJlYWR5UHJpbnRlZCxcbiAgICBkZWZlcnJlZDogTWF0aC5tYXgoMCwgdW5wcmludGVkLmxlbmd0aCAtIHNlbGVjdGVkLmxlbmd0aCksXG4gIH07XG59Il0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sWUFBWTtBQUNuQixPQUFPLFVBQVU7OztBQ0RWLFNBQVMsTUFBTSxJQUEyQjtBQUMvQyxTQUFPLElBQUksUUFBUSxDQUFDLFlBQVksV0FBVyxTQUFTLEVBQUUsQ0FBQztBQUN6RDtBQVNPLElBQU0sY0FBTixNQUFrQjtBQUFBLEVBSXZCLFlBQTZCLGVBQXVCO0FBQXZCO0FBQUEsRUFBd0I7QUFBQSxFQUg3QyxRQUF1QixRQUFRLFFBQVE7QUFBQSxFQUN2QyxxQkFBcUI7QUFBQSxFQUk3QixTQUFZLElBQWtDO0FBQzVDLFVBQU0sTUFBTSxLQUFLLE1BQU0sS0FBSyxZQUFZO0FBQ3RDLFlBQU0sT0FBTyxLQUFLLHFCQUFxQixLQUFLLGdCQUFnQixLQUFLLElBQUk7QUFDckUsVUFBSSxPQUFPLEdBQUc7QUFDWixjQUFNLE1BQU0sSUFBSTtBQUFBLE1BQ2xCO0FBQ0EsVUFBSTtBQUNGLGVBQU8sTUFBTSxHQUFHO0FBQUEsTUFDbEIsVUFBRTtBQUNBLGFBQUsscUJBQXFCLEtB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
