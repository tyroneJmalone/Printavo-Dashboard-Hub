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
  status { id name }
  owner { id email }
  contact { id fullName email customer { id companyName } }
  shippingAddress { ${ADDRESS_FIELDS} }
  billingAddress { ${ADDRESS_FIELDS} }
  deliveryMethod { name }
  timestamps { createdAt updatedAt }
`;

const PAGE_INFO = `pageInfo { hasNextPage endCursor }`;

export interface OrderPageArgs {
  after?: string | null;
}

export function invoicesPageQuery(args: OrderPageArgs = {}): string {
  return `query {
    invoices(first: ${PAGE_SIZE}${afterArg(args.after)}, sortOn: VISUAL_ID, sortDescending: true) {
      nodes { ${ORDER_NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }`;
}

export function quotesPageQuery(args: OrderPageArgs = {}): string {
  return `query {
    quotes(first: ${PAGE_SIZE}${afterArg(args.after)}, sortOn: VISUAL_ID, sortDescending: true) {
      nodes { ${ORDER_NODE_FIELDS} }
      ${PAGE_INFO}
    }
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
): string {
  return `lineItemGroups(first: ${groupsFirst}) {
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
    pageInfo { hasNextPage }
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
): string {
  return `query {
    ${kind}(first: ${DETAIL_PAGE_SIZE}${afterArg(after)}, sortOn: VISUAL_ID, sortDescending: true) {
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
      ${lineItemGroupsSelection(20, 40, 15)}
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
    ... on Invoice { id visualId }
    ... on Quote { id visualId }
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
