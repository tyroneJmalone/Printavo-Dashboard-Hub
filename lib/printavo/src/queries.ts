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
  tags
  status { id name }
  owner { id email }
  contact { id fullName email customer { id companyName } }
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
      nodes { id name }
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
