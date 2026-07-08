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
