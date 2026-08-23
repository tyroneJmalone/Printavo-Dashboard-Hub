/**
 * GraphQL query builders for Printavo v2.
 *
 * Values are inlined as literals (safely JSON-quoted) instead of typed
 * variables so we never have to guess Printavo's scalar/enum type names.
 *
 * Constraints (verified via live schema introspection, July 2026):
 * - page size hard-capped at 25 regardless of `first`
 * - NO `updatedAfter` / changed-since filter exists on any list field
 * - no UPDATED_AT sort; VISUAL_ID desc is the recency proxy, so
 *   incremental sync = full re-crawl to cutoff + hash diff
 */

export const PAGE_SIZE = 25;

function lit(value: string): string {
  return JSON.stringify(value);
}

function afterArg(after: string | null | undefined): string {
  return after ? `, after: ${lit(after)}` : "";
}

const ADDRESS_FIELDS = `
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

const ORDER_NODE_FIELDS = `
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

const PAGE_INFO = `pageInfo { hasNextPage endCursor }`;

export interface OrderPageArgs {
  after?: string | null;
  /**
   * VISUAL_ID sort direction. Default true (newest-first) — the
   * incremental crawl's recency proxy. History backfill passes false
   * to walk the archive oldest-first (verified live: ascending sort
   * works; note visual ids are NOT date-ordered, e.g. invoice #1000
   * was created in 2021).
   */
  sortDescending?: boolean;
}

function sortDescArg(sortDescending: boolean | undefined): string {
  return sortDescending === false ? "false" : "true";
}

export function invoicesPageQuery(args: OrderPageArgs = {}): string {
  return `query {
    invoices(first: ${PAGE_SIZE}${afterArg(args.after)}, sortOn: VISUAL_ID, sortDescending: ${sortDescArg(args.sortDescending)}) {
      nodes { ${ORDER_NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }`;
}

export function quotesPageQuery(args: OrderPageArgs = {}): string {
  return `query {
    quotes(first: ${PAGE_SIZE}${afterArg(args.after)}, sortOn: VISUAL_ID, sortDescending: ${sortDescArg(args.sortDescending)}) {
      nodes { ${ORDER_NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }`;
}

/**
 * Order-list totals: history-backfill progress denominator + final
 * gap verification (DB row count vs Printavo's totalNodes).
 */
export function orderTotalsQuery(): string {
  return `query {
    invoices(first: 1) { totalNodes }
    quotes(first: 1) { totalNodes }
  }`;
}

export function customersPageQuery(after?: string | null): string {
  return `query {
    customers(first: ${PAGE_SIZE}${afterArg(after)}) {
      nodes {
        id
        companyName
        owner { id email }
        primaryContact { id fullName email }
        timestamps { createdAt updatedAt }
      }
      ${PAGE_INFO}
    }
  }`;
}

export function contactsPageQuery(after?: string | null): string {
  return `query {
    contacts(first: ${PAGE_SIZE}${afterArg(after)}) {
      nodes {
        id
        fullName
        email
        phone
        customer { id companyName }
        timestamps { createdAt updatedAt }
      }
      ${PAGE_INFO}
    }
  }`;
}

export function statusesPageQuery(after?: string | null): string {
  return `query {
    statuses(first: ${PAGE_SIZE}${afterArg(after)}) {
      nodes { id name color position }
      ${PAGE_INFO}
    }
  }`;
}

/** Cheapest possible authenticated request — proves creds + connectivity. */
export function probeQuery(): string {
  return `query { statuses(first: 1) { nodes { id name } } }`;
}

/*
 * ── Order detail (line items / imprints) ────────────────────────────────
 * Complexity cap is 25,000. The nested list crawl fits at 8 orders/page
 * with the slim field set below (probed live July 2026); the single-order
 * query uses generous limits for topping up truncated connections.
 */

/** Orders per page for the nested detail crawl (complexity-limited: 6 ≈ 22k of the 25k cap; 7 = 25,723 rejected). */
export const DETAIL_PAGE_SIZE = 6;
const DETAIL_GROUPS_FIRST = 8;
const DETAIL_LINE_ITEMS_FIRST = 20;
const DETAIL_IMPRINTS_FIRST = 8;

const LINE_ITEM_FIELDS = `
  id
  itemNumber
  color
  description
  items
  price
  merch
  productStatus
  sizes { size count }
  category { id name }
  product { id brand }
`;

const IMPRINT_FIELDS = `
  id
  details
  pricingMatrixColumn { id columnName matrix { id name } }
  typeOfWork { id name }
`;

function lineItemGroupsSelection(
  groupsFirst: number,
  lineItemsFirst: number,
  imprintsFirst: number,
  opts?: { withGroupCursor?: boolean; after?: string | null },
): string {
  const groupPageInfo = opts?.withGroupCursor
    ? `pageInfo { hasNextPage endCursor }`
    : `pageInfo { hasNextPage }`;
  return `lineItemGroups(first: ${groupsFirst}${afterArg(opts?.after)}) {
    nodes {
      id
      position
      lineItems(first: ${lineItemsFirst}) {
        nodes { ${LINE_ITEM_FIELDS} }
        pageInfo { hasNextPage }
      }
      imprints(first: ${imprintsFirst}) {
        nodes { ${IMPRINT_FIELDS} }
        pageInfo { hasNextPage }
      }
    }
    ${groupPageInfo}
  }`;
}

export type OrderKind = "invoices" | "quotes";

/**
 * Nested detail crawl page: orders (VISUAL_ID desc) with line item groups,
 * line items, and imprints inline. Truncation detectable via the nested
 * pageInfo.hasNextPage flags — top up with singleOrderDetailQuery.
 */
export function orderDetailPageQuery(
  kind: OrderKind,
  after?: string | null,
  opts: { sortDescending?: boolean } = {},
): string {
  return `query {
    ${kind}(first: ${DETAIL_PAGE_SIZE}${afterArg(after)}, sortOn: VISUAL_ID, sortDescending: ${sortDescArg(opts.sortDescending)}) {
      nodes {
        id
        visualId
        totalQuantity
        timestamps { createdAt updatedAt }
        ${lineItemGroupsSelection(DETAIL_GROUPS_FIRST, DETAIL_LINE_ITEMS_FIRST, DETAIL_IMPRINTS_FIRST)}
      }
      ${PAGE_INFO}
    }
  }`;
}

/**
 * Single-order detail with generous limits (top-up for truncated orders).
 * 20/40/15 probed OK July 2026; 25/50/25 = complexity 29,636 > 25k cap.
 */
export function singleOrderDetailQuery(
  kind: "invoice" | "quote",
  printavoId: string,
): string {
  return `query {
    ${kind}(id: ${lit(printavoId)}) {
      id
      visualId
      totalQuantity
      timestamps { createdAt updatedAt }
      ${lineItemGroupsSelection(20, 40, 15, { withGroupCursor: true })}
    }
  }`;
}

/**
 * Follow-up page of lineItemGroups for orders with more groups than the
 * single-order query's first page (the >25-group truncation fix). Same
 * generous nested limits; cursor continues from the previous page.
 */
export function orderGroupsPageQuery(
  kind: "invoice" | "quote",
  printavoId: string,
  after: string,
): string {
  return `query {
    ${kind}(id: ${lit(printavoId)}) {
      id
      ${lineItemGroupsSelection(10, 40, 15, { withGroupCursor: true, after })}
    }
  }`;
}

/*
 * ── Product-status sweep (slim) ─────────────────────────────────────────
 * Printavo does NOT bump an order's updatedAt when a line item's
 * productStatus changes (verified live July 2026), so the hash-based list
 * crawl never notices. This slim page fetches ONLY line item id +
 * productStatus so the sync can diff against the DB and re-pull details
 * for mismatched orders. Nesting limits (25 invoices × 5 groups × 8 items)
 * are the legacy PO Builder's proven-safe complexity budget — do NOT raise.
 */

const SWEEP_GROUPS_FIRST = 5;
const SWEEP_LINE_ITEMS_FIRST = 8;

export function productStatusSweepPageQuery(after?: string | null): string {
  return `query {
    invoices(first: ${PAGE_SIZE}${afterArg(after)}, sortOn: VISUAL_ID, sortDescending: true) {
      nodes {
        id
        timestamps { createdAt updatedAt }
        lineItemGroups(first: ${SWEEP_GROUPS_FIRST}) {
          nodes {
            id
            lineItems(first: ${SWEEP_LINE_ITEMS_FIRST}) {
              nodes { id productStatus }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      ${PAGE_INFO}
    }
  }`;
}

/*
 * ── PO push write mutations (P3c) ───────────────────────────────────────
 * Verified via live introspection July 2026:
 * - lineItemUpdate(id: ID!, input: LineItemInput!) — position is REQUIRED
 *   in the input or the mutation fails; productStatus is the LineItemStatus
 *   enum (need_ordering, attached_to_po, ordered, arrived,
 *   partially_received, received, in); sizes is [LineItemSizeCountInput!]
 *   with size being the LineItemSize enum (size_s … size_5t).
 * - productionFileCreate(parentId: ID!, publicFileUrl: String!) — Printavo
 *   fetches the file from the URL asynchronously after the mutation.
 */

/** LineItemSize enum values accepted by lineItemUpdate (introspected live). */
export const PRINTAVO_SIZE_ENUM = new Set([
  "size_yxs", "size_ys", "size_ym", "size_yl", "size_yxl",
  "size_xs", "size_s", "size_m", "size_l", "size_xl",
  "size_2xl", "size_3xl", "size_4xl", "size_5xl", "size_6xl",
  "size_other",
  "size_6m", "size_12m", "size_18m", "size_24m",
  "size_2t", "size_3t", "size_4t", "size_5t",
]);

/**
 * Map a Hub-normalized size label (stripped `size_` prefix, uppercased —
 * e.g. "M", "2XL", "6M") back to Printavo's LineItemSize enum. Returns null
 * for anything that does not map exactly (e.g. the synthetic "OSFA" rows the
 * cart adds for size-less lines) — callers must then leave sizes untouched.
 */
export function toLineItemSizeEnum(label: string): string | null {
  const candidate = `size_${label.trim().toLowerCase()}`;
  return PRINTAVO_SIZE_ENUM.has(candidate) ? candidate : null;
}

/** Line item statuses that mean "the goods are already ordered/here" — a push must skip these. */
export const ORDERED_OR_LATER_STATUSES = new Set([
  "ordered",
  "arrived",
  "partially_received",
  "received",
]);

/** Slim single line item fetch used by the PO push to diff before writing. */
export function poPushLineItemQuery(lineItemId: string): string {
  return `query {
    lineItem(id: ${lit(lineItemId)}) {
      id
      position
      productStatus
      itemNumber
      color
      sizes { size count }
    }
  }`;
}

export interface LineItemUpdateInput {
  /** REQUIRED by Printavo's LineItemInput. */
  position: number;
  /** LineItemStatus enum value, e.g. "ordered" (unquoted enum literal). */
  productStatus?: string;
  itemNumber?: string;
  color?: string;
  /** Pairs of (LineItemSize enum value, count). Enum values must come from PRINTAVO_SIZE_ENUM. */
  sizes?: Array<{ size: string; count: number }>;
}

const ENUM_LITERAL = /^[a-z_][a-z0-9_]*$/;

function enumLit(value: string, what: string): string {
  if (!ENUM_LITERAL.test(value)) {
    throw new Error(`Invalid ${what} enum value: ${JSON.stringify(value)}`);
  }
  return value;
}

export function lineItemUpdateMutation(
  lineItemId: string,
  input: LineItemUpdateInput,
): string {
  const parts: string[] = [`position: ${Math.trunc(input.position)}`];
  if (input.productStatus !== undefined) {
    parts.push(`productStatus: ${enumLit(input.productStatus, "LineItemStatus")}`);
  }
  if (input.itemNumber !== undefined) parts.push(`itemNumber: ${lit(input.itemNumber)}`);
  if (input.color !== undefined) parts.push(`color: ${lit(input.color)}`);
  if (input.sizes !== undefined) {
    const sizeLits = input.sizes.map(
      (s) => `{ size: ${enumLit(s.size, "LineItemSize")}, count: ${Math.trunc(s.count)} }`,
    );
    parts.push(`sizes: [${sizeLits.join(", ")}]`);
  }
  return `mutation {
    lineItemUpdate(id: ${lit(lineItemId)}, input: { ${parts.join(", ")} }) {
      id
      productStatus
    }
  }`;
}

export interface QuoteCreateLineItem {
  position: number;
  itemNumber: string;
  description: string;
  color: string;
  price: number;
  markupPercentage: number;
  sizes: Array<{ size: string; count: number }>;
}

export interface QuoteCreateImprint {
  details: string;
  pricingMatrixColumnId: string;
}

export interface QuoteCreateLineItemGroup {
  position: number;
  lineItems: QuoteCreateLineItem[];
  imprints: QuoteCreateImprint[];
}

export interface QuoteCreateInput {
  contactId: string;
  customerDueAt: string;
  dueAt: string;
  nickname: string;
  customerNote?: string;
  productionNote?: string;
  lineItemGroups: QuoteCreateLineItemGroup[];
}

/**
 * Build the single nested Printavo quoteCreate mutation. Input shape was
 * verified through live schema introspection in August 2026. Every enum value
 * is validated before it is emitted as an unquoted GraphQL literal.
 */
export function quoteCreateMutation(input: QuoteCreateInput): string {
  const groups = input.lineItemGroups.map((group) => {
    const lineItems = group.lineItems.map((item) => {
      const sizes = item.sizes.map(
        (size) =>
          `{ size: ${enumLit(size.size, "LineItemSize")}, count: ${Math.trunc(size.count)} }`,
      );
      return `{ position: ${Math.trunc(item.position)}, itemNumber: ${lit(item.itemNumber)}, description: ${lit(item.description)}, color: ${lit(item.color)}, price: ${Number(item.price).toFixed(2)}, markupPercentage: ${Number(item.markupPercentage).toFixed(4)}, productStatus: need_ordering, taxed: true, sizes: [${sizes.join(", ")}] }`;
    });
    const imprints = group.imprints.map((imprint) => {
      return `{ details: ${lit(imprint.details)}, pricingMatrixColumn: { id: ${lit(imprint.pricingMatrixColumnId)} } }`;
    });
    return `{ position: ${Math.trunc(group.position)}, lineItems: [${lineItems.join(", ")}], imprints: [${imprints.join(", ")}] }`;
  });

  const parts = [
    `contact: { id: ${lit(input.contactId)} }`,
    `customerDueAt: ${lit(input.customerDueAt)}`,
    `dueAt: ${lit(input.dueAt)}`,
    `nickname: ${lit(input.nickname)}`,
    `lineItemGroups: [${groups.join(", ")}]`,
  ];
  if (input.customerNote) parts.push(`customerNote: ${lit(input.customerNote)}`);
  if (input.productionNote) {
    parts.push(`productionNote: ${lit(input.productionNote)}`);
  }

  return `mutation {
    quoteCreate(input: { ${parts.join(", ")} }) {
      id
      visualId
      publicUrl
      nickname
      total
      customerDueAt
      dueAt
    }
  }`;
}

export function productionFileCreateMutation(
  parentId: string,
  publicFileUrl: string,
): string {
  return `mutation {
    productionFileCreate(parentId: ${lit(parentId)}, publicFileUrl: ${lit(publicFileUrl)}) {
      id
      fileUrl
    }
  }`;
}

/**
 * Change an order's status. `parentId` is the invoice/quote GraphQL id;
 * returns OrderUnion, so the selection needs inline fragments (verified via
 * introspection: statusUpdate(parentId: ID!, statusId: ID!): OrderUnion).
 */
export function statusUpdateMutation(parentId: string, statusId: string): string {
  return `mutation {
    statusUpdate(parentId: ${lit(parentId)}, statusId: ${lit(statusId)}) {
      ... on Invoice { id status { id name } }
      ... on Quote { id status { id name } }
    }
  }`;
}

/*
 * ── Transactions (cash-basis payments) ──────────────────────────────────
 * Root `transactions` has pagination only (no date filter), newest-first.
 * TransactionUnion members all share the same core fields; Payment adds
 * `source`, PaymentDispute adds `status`.
 */

const TRANSACTION_CORE_FIELDS = `
  id
  amount
  category
  description
  processing
  transactionDate
  timestamps { createdAt updatedAt }
  transactedFor {
    __typename
    ... on Invoice { id visualId }
    ... on Quote { id visualId }
    ... on MerchOrder { id }
  }
`;

export function transactionsPageQuery(after?: string | null): string {
  return `query {
    transactions(first: ${PAGE_SIZE}${afterArg(after)}) {
      nodes {
        __typename
        ... on Payment { ${TRANSACTION_CORE_FIELDS} source }
        ... on Refund { ${TRANSACTION_CORE_FIELDS} }
        ... on Return { ${TRANSACTION_CORE_FIELDS} }
        ... on Void { ${TRANSACTION_CORE_FIELDS} }
        ... on PaymentDispute { ${TRANSACTION_CORE_FIELDS} status }
      }
      ${PAGE_INFO}
    }
  }`;
}

/*
 * ── Tasks ────────────────────────────────────────────────────────────────
 * Verified via live introspection + live test (July 2026):
 * - tasks(first, after, assigneeId, completed, dueAfter, dueBefore, sortOn,
 *   sortDescending); NO updatedAfter filter → sync = full open-task re-scan.
 * - taskable: Customer | Invoice | Quote; null = standalone "calendar" task.
 * - taskUpdate has MERGE semantics: sending only { completed } preserves
 *   name/dueAt/assignedTo (live-verified on a throwaway task).
 * - taskDelete returns DeletedID and requires a selection set.
 */

const TASK_NODE_FIELDS = `
  id
  name
  dueAt
  completed
  completedAt
  assignedTo { id name email }
  taskable {
    __typename
    ... on Invoice { id visualId nickname contact { fullName customer { companyName } } }
    ... on Quote { id visualId nickname contact { fullName customer { companyName } } }
    ... on Customer { id }
  }
  timestamps { createdAt updatedAt }
`;

export function tasksPageQuery(args: {
  after?: string | null;
  completed?: boolean;
} = {}): string {
  const completedArg =
    args.completed !== undefined ? `, completed: ${args.completed}` : "";
  return `query {
    tasks(first: ${PAGE_SIZE}${afterArg(args.after)}${completedArg}) {
      nodes { ${TASK_NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }`;
}

export function taskDetailQuery(taskId: string): string {
  return `query {
    task(id: ${lit(taskId)}) { ${TASK_NODE_FIELDS} }
  }`;
}

export interface TaskWriteInput {
  name?: string;
  /** ISO8601 timestamp or null semantics not supported — omit to keep. */
  dueAt?: string;
  completed?: boolean;
  /** Printavo User.id — omit to keep, set to assign. */
  assignedToId?: string;
}

function taskInputParts(input: TaskWriteInput): string {
  const parts: string[] = [];
  if (input.name !== undefined) parts.push(`name: ${lit(input.name)}`);
  if (input.dueAt !== undefined) parts.push(`dueAt: ${lit(input.dueAt)}`);
  if (input.completed !== undefined) parts.push(`completed: ${input.completed}`);
  if (input.assignedToId !== undefined) {
    parts.push(`assignedTo: { id: ${lit(input.assignedToId)} }`);
  }
  return parts.join(", ");
}

/** Creates a STANDALONE (calendar) task — no taskable on purpose. */
export function taskCreateMutation(input: TaskWriteInput & { name: string }): string {
  return `mutation {
    taskCreate(input: { ${taskInputParts(input)} }) { ${TASK_NODE_FIELDS} }
  }`;
}

/** MERGE semantics: only the provided fields change (live-verified). */
export function taskUpdateMutation(taskId: string, input: TaskWriteInput): string {
  return `mutation {
    taskUpdate(id: ${lit(taskId)}, input: { ${taskInputParts(input)} }) { ${TASK_NODE_FIELDS} }
  }`;
}

export function taskDeleteMutation(taskId: string): string {
  return `mutation {
    taskDelete(id: ${lit(taskId)}) { id }
  }`;
}

/** Account users, for mapping assignee emails → Printavo user IDs. */
export function accountUsersQuery(after?: string | null): string {
  return `query {
    account {
      users(first: ${PAGE_SIZE}${afterArg(after)}) {
        nodes { id name email }
        ${PAGE_INFO}
      }
    }
  }`;
}

/*
 * ── Order extras (backup module, full-fidelity capture) ─────────────────
 * Per-order supplemental query for everything the hot sync paths skip:
 * fees, expenses, approval requests, production files, custom addresses,
 * thread summary, payment request, plus line-item/imprint enrichment
 * (mockups, personalizations, price receipts, product catalog refs, PO
 * links). Stored as one raw blob in pv_orders.extras — no hot columns.
 *
 * Complexity budget: kept well under the 25k cap by modest first: limits;
 * every connection carries pageInfo so callers can detect + follow
 * overflow with the targeted page queries below.
 */

// Probed July 2026: 10/25/12/6 = complexity 29,976 > 25k cap; 8/20/10/5
// lands safely under. Bigger orders just take extra cursor pages.
export const EXTRAS_GROUPS_FIRST = 8;
export const EXTRAS_LINE_ITEMS_FIRST = 20;
export const EXTRAS_IMPRINTS_FIRST = 10;
export const EXTRAS_MOCKUPS_FIRST = 5;
export const EXTRAS_CONNECTION_FIRST = 25;

const MOCKUP_FIELDS = `
  id
  fullImageUrl
  thumbnailUrl
  mimeType
  displayThumbnail
  timestamps { createdAt updatedAt }
`;

const EXTRAS_LINE_ITEM_FIELDS = `
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

const EXTRAS_IMPRINT_FIELDS = `
  id
  mockups(first: ${EXTRAS_MOCKUPS_FIRST}) {
    nodes { ${MOCKUP_FIELDS} }
    pageInfo { hasNextPage }
  }
`;

const EXTRAS_ORDER_CONNECTIONS = `
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

function extrasGroupsSelection(after?: string | null): string {
  return `lineItemGroups(first: ${EXTRAS_GROUPS_FIRST}${afterArg(after)}) {
    nodes {
      id
      lineItems(first: ${EXTRAS_LINE_ITEMS_FIRST}) {
        nodes { ${EXTRAS_LINE_ITEM_FIELDS} }
        pageInfo { hasNextPage }
      }
      imprints(first: ${EXTRAS_IMPRINTS_FIRST}) {
        nodes { ${EXTRAS_IMPRINT_FIELDS} }
        pageInfo { hasNextPage }
      }
    }
    ${PAGE_INFO}
  }`;
}

export function orderExtrasQuery(
  kind: "invoice" | "quote",
  printavoId: string,
): string {
  return `query {
    ${kind}(id: ${lit(printavoId)}) {
      id
      visualId
      ${EXTRAS_ORDER_CONNECTIONS}
      ${extrasGroupsSelection()}
    }
  }`;
}

/** Follow-up page of extras lineItemGroups (orders with >10 groups). */
export function orderExtrasGroupsPageQuery(
  kind: "invoice" | "quote",
  printavoId: string,
  after: string,
): string {
  return `query {
    ${kind}(id: ${lit(printavoId)}) {
      id
      ${extrasGroupsSelection(after)}
    }
  }`;
}

/**
 * Follow-up page for an overflowed order-level extras connection
 * (fees / expenses / approvalRequests / productionFiles / customAddresses
 * beyond the first 25 — rare, but paged for correctness).
 */
export function orderExtrasConnectionPageQuery(
  kind: "invoice" | "quote",
  printavoId: string,
  connection:
    | "fees"
    | "expenses"
    | "approvalRequests"
    | "productionFiles"
    | "customAddresses",
  after: string,
): string {
  const selections: Record<string, string> = {
    fees: `id amount description quantity taxable unitPrice unitPriceAsPercentage timestamps { createdAt updatedAt }`,
    expenses: `id name amount transactionAt userGenerated timestamps { createdAt updatedAt }`,
    approvalRequests: `id name status requester { id name email } retractor { id name email } response { name email reason respondedAt } timestamps { createdAt updatedAt }`,
    productionFiles: `id name fileUrl mimeType timestamps { createdAt updatedAt }`,
    customAddresses: `id name customerName companyName address1 address2 city state stateIso zipCode country countryIso timestamps { createdAt updatedAt }`,
  };
  return `query {
    ${kind}(id: ${lit(printavoId)}) {
      id
      ${connection}(first: ${EXTRAS_CONNECTION_FIRST}${afterArg(after)}) {
        nodes { ${selections[connection]} }
        ${PAGE_INFO}
      }
    }
  }`;
}

/*
 * ── B4 backup entities (threads/messages, merch, inquiries, payment
 *    requests, account reference data) ──────────────────────────────────
 * All raw-blob captures. Introspected live July 2026:
 * - threads → ThreadSummaryConnection ONLY (id, unread, regarding,
 *   lastReceivedMessage); full messages require thread(id){messages}.
 *   The list is ordered by lastReceivedMessage recency (verified across
 *   pages), and lastReceivedMessage tracks INCOMING messages only.
 * - merch orders have NO root list — only merchStore(id).orders.
 * - PricingMatrixCell exposes NO price/quantity values (structural ids
 *   only), so matrices are captured with columns but without cells.
 */

const THREAD_REGARDING = `
  regarding {
    __typename
    ... on Invoice { id visualId }
    ... on Quote { id visualId }
  }
`;

export function threadsPageQuery(after?: string | null): string {
  return `query {
    threads(first: ${PAGE_SIZE}${afterArg(after)}) {
      nodes {
        id
        unread
        ${THREAD_REGARDING}
        lastReceivedMessage {
          __typename
          ... on EmailMessage { id timestamps { createdAt } }
          ... on TextMessage { id timestamps { createdAt } }
        }
      }
      ${PAGE_INFO}
    }
  }`;
}

const MESSAGE_PARTICIPANT = `
  __typename
  ... on Contact { id fullName email }
  ... on User { id name email }
`;

const MESSAGE_COMMON_FIELDS = `
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

/** One page of a thread's full messages (25/page, paged to exhaustion). */
export function threadMessagesPageQuery(
  threadId: string,
  after?: string | null,
): string {
  return `query {
    thread(id: ${lit(threadId)}) {
      id
      unread
      messages(first: ${PAGE_SIZE}${afterArg(after)}) {
        nodes {
          __typename
          ... on EmailMessage { ${MESSAGE_COMMON_FIELDS} subject cc bcc }
          ... on TextMessage { ${MESSAGE_COMMON_FIELDS} }
        }
        ${PAGE_INFO}
      }
    }
  }`;
}

export function inquiriesPageQuery(after?: string | null): string {
  return `query {
    inquiries(first: ${PAGE_SIZE}${afterArg(after)}) {
      nodes {
        id
        name
        email
        phone
        request
        unread
        timestamps { createdAt updatedAt }
      }
      ${PAGE_INFO}
    }
  }`;
}

/**
 * Payment requests, newest-first. List page size 10 (not 25) — the two
 * nested first:25 connections would otherwise risk the 25k complexity
 * cap (probed OK live at 10/25/25, July 2026).
 */
export const PAYMENT_REQUESTS_PAGE_SIZE = 10;

export function paymentRequestsPageQuery(
  after?: string | null,
  options?: { omitRequestedBy?: boolean },
): string {
  // Printavo declares PaymentRequest.requestedBy non-nullable, but it
  // CAN be null in practice (requesting user deleted) — and the whole
  // response data nulls out (verified live: no partial data survives).
  // Callers retry the poisoned page without the field.
  const requestedByField = options?.omitRequestedBy
    ? ""
    : "\n        requestedBy { id name email }";
  return `query {
    paymentRequests(first: ${PAYMENT_REQUESTS_PAGE_SIZE}${afterArg(after)}, sortDescending: true) {
      nodes {
        id
        visualId
        amount
        description
        nickname
        status
        requestedAt${requestedByField}
        contact { id companyName }
        requestedDetails(first: 25) {
          nodes {
            id
            orderVisualId
            requestedAmount
            timestamps { createdAt updatedAt }
          }
          pageInfo { hasNextPage }
        }
        payments(first: 25) {
          nodes {
            id
            amount
            category
            description
            processing
            source
            transactionDate
            timestamps { createdAt updatedAt }
          }
          pageInfo { hasNextPage }
        }
        timestamps { createdAt updatedAt }
      }
      ${PAGE_INFO}
    }
  }`;
}

export function merchStoresPageQuery(after?: string | null): string {
  return `query {
    merchStores(first: ${PAGE_SIZE}${afterArg(after)}) {
      nodes {
        id
        name
        status
        closesAt
        summary { itemsSold totalSales totalTax }
        timestamps { createdAt updatedAt }
      }
      ${PAGE_INFO}
    }
  }`;
}

const MERCH_ADDRESS_FIELDS = `
  id
  name
  phone
  residential
  address1
  address2
  city
  state
  stateIso
  zipCode
  country
  countryIso
`;

/** One page of a merch store's orders (only reachable per-store). */
export function merchStoreOrdersPageQuery(
  storeId: string,
  after?: string | null,
): string {
  return `query {
    merchStore(id: ${lit(storeId)}) {
      id
      orders(first: ${PAGE_SIZE}${afterArg(after)}) {
        nodes {
          id
          visualId
          status
          quantity
          itemTotal
          promoTotal
          tax
          total
          completedAt
          delivery { flatRate method total totalActual }
          billingAddress { ${MERCH_ADDRESS_FIELDS} }
          shippingAddress { ${MERCH_ADDRESS_FIELDS} }
          timestamps { createdAt updatedAt }
        }
        ${PAGE_INFO}
      }
    }
  }`;
}

/**
 * Account-level reference connections, one query per kind. Kind keys
 * double as pv_reference_blobs.kind values.
 */
export const REFERENCE_KINDS = [
  "delivery_method",
  "payment_term",
  "user",
  "pricing_matrix",
  "email_template",
  "type_of_work",
  "category",
  "preset_task_group",
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

const REFERENCE_SELECTIONS: Record<ReferenceKind, { field: string; selection: string }> = {
  delivery_method: {
    field: "deliveryMethods",
    selection: `id name archived timestamps { createdAt updatedAt }`,
  },
  payment_term: {
    field: "paymentTerms",
    selection: `id name days archived inUse timestamps { createdAt updatedAt }`,
  },
  user: {
    field: "users",
    selection: `id name email phone timeZone timestamps { createdAt updatedAt }`,
  },
  pricing_matrix: {
    field: "pricingMatrices",
    selection: `id name typeOfWork { id name archived } columns { id columnName } timestamps { createdAt updatedAt }`,
  },
  email_template: {
    field: "emailTemplates",
    selection: `id name subject body timestamps { createdAt updatedAt }`,
  },
  type_of_work: {
    field: "typesOfWork",
    selection: `id name archived timestamps { createdAt updatedAt }`,
  },
  category: {
    field: "categories",
    selection: `id name timestamps { createdAt updatedAt }`,
  },
  preset_task_group: {
    field: "presetTaskGroups",
    selection: `id title presetTasks(first: 25) { nodes { id name position assignedTo { id name email } } pageInfo { hasNextPage } } timestamps { createdAt updatedAt }`,
  },
};

/** The account connection field name for a reference kind (for response parsing). */
export function referenceFieldFor(kind: ReferenceKind): string {
  return REFERENCE_SELECTIONS[kind].field;
}

export function accountReferencePageQuery(
  kind: ReferenceKind,
  after?: string | null,
): string {
  const { field, selection } = REFERENCE_SELECTIONS[kind];
  return `query {
    account {
      ${field}(first: ${PAGE_SIZE}${afterArg(after)}) {
        nodes { ${selection} }
        ${PAGE_INFO}
      }
    }
  }`;
}

// ── Hub Price Calculator mutations (added for Task #27) ──────────────────

/**
 * Fetch a single invoice by its internal Printavo id, returning only the
 * fields needed by the Hub Price Calculator push (productionNote + id/visualId).
 */
export function invoiceByIdQuery(printavoId: string): string {
  return `query {
    invoice(id: ${lit(printavoId)}) {
      id
      visualId
      productionNote
    }
  }`;
}

/**
 * Fetch a single quote by its internal Printavo id, returning only the
 * fields needed by the Hub Price Calculator push (productionNote + id/visualId).
 *
 * NOTE: Quote.visualId is a String in the Printavo schema (Invoice.visualId
 * is an Int) — callers must normalize with Number().
 */
export function quoteByIdQuery(printavoId: string): string {
  return `query {
    quote(id: ${lit(printavoId)}) {
      id
      visualId
      productionNote
    }
  }`;
}

export interface InvoiceUpdateInput {
  productionNote?: string;
}

/**
 * Update an invoice's mutable header fields (Hub Price Calculator push).
 * Only non-undefined fields are emitted.
 * Uses `invoiceUpdate(id, input)` — verified via Printavo schema.
 */
export function invoiceUpdateMutation(
  invoiceId: string,
  input: InvoiceUpdateInput,
): string {
  const parts: string[] = [];
  if (input.productionNote !== undefined) {
    parts.push(`productionNote: ${lit(input.productionNote)}`);
  }
  if (parts.length === 0) {
    throw new Error("invoiceUpdateMutation: at least one field must be provided");
  }
  return `mutation {
    invoiceUpdate(id: ${lit(invoiceId)}, input: { ${parts.join(", ")} }) {
      id
      visualId
      productionNote
    }
  }`;
}

export interface QuoteUpdateInput {
  productionNote?: string;
}

/**
 * Update a quote's mutable header fields (Hub Price Calculator push).
 * Only non-undefined fields are emitted.
 * Uses `quoteUpdate(id, input)` with Printavo's QuoteInput type — verified
 * via schema introspection that QuoteInput includes productionNote.
 */
export function quoteUpdateMutation(
  quoteId: string,
  input: QuoteUpdateInput,
): string {
  const parts: string[] = [];
  if (input.productionNote !== undefined) {
    parts.push(`productionNote: ${lit(input.productionNote)}`);
  }
  if (parts.length === 0) {
    throw new Error("quoteUpdateMutation: at least one field must be provided");
  }
  return `mutation {
    quoteUpdate(id: ${lit(quoteId)}, input: { ${parts.join(", ")} }) {
      id
      visualId
      productionNote
    }
  }`;
}
