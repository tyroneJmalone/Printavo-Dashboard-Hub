import {
  invoicesPageQuery,
  quotesPageQuery,
  singleOrderStatusQuery,
  type Connection,
  type InvoicesPage,
  type OrderKind,
  type PvOrderNode,
  type QuotesPage,
  type SingleOrderStatus,
} from "@workspace/printavo";
import { getPrintavoClient } from "../../printavoGateway";

// At 25 records/page this allows 1,250 matches per kind, without turning
// auto-print into a historical sync. Exceeding the budget fails closed.
export const MAX_DISCOVERY_PAGES_PER_KIND = 50;
export const MAX_DISCOVERY_DURATION_MS = 120_000;

/**
 * A deliberately small client surface keeps live discovery unit-testable while
 * still requiring the production caller to use the shared Printavo gateway.
 */
export interface LiveOrderQueryClient {
  query<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
}

export interface LiveAutoPrintOrder {
  kind: OrderKind;
  node: PvOrderNode;
}

export interface LiveDiscoveryResult {
  orders: LiveAutoPrintOrder[];
  pages: Record<"invoices" | "quotes", number>;
}

export type LiveDiscoveryErrorKind =
  | "request"
  | "budget_exceeded"
  | "unsupported_filter"
  | "incomplete_pagination"
  | "invalid_response";

/**
 * Discovery errors are intentionally distinct from per-order print errors.
 * The engine must fail the run before rendering or submitting anything when
 * live discovery is not complete.
 */
export class LiveDiscoveryError extends Error {
  constructor(
    message: string,
    public readonly kind: LiveDiscoveryErrorKind,
  ) {
    super(message);
    this.name = "LiveDiscoveryError";
  }
}

export interface LiveOrderStatus {
  orderId: string;
  visualId: number | null;
  statusId: string | null;
  statusName: string | null;
}

function normalizeVisualId(raw: unknown): number | null {
  const visualId =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw)
        : Number.NaN;
  return Number.isSafeInteger(visualId) ? visualId : null;
}

/**
 * Read one exact order's current status through the shared gateway. This is
 * intentionally separate from detail refresh: detail queries do not include
 * status and therefore cannot be a print/status-write stale guard.
 */
export async function fetchLiveOrderStatus(
  kind: "invoice" | "quote",
  orderId: string,
  client: LiveOrderQueryClient = getPrintavoClient(),
): Promise<LiveOrderStatus | null> {
  const data = await client.query<SingleOrderStatus>(
    singleOrderStatusQuery(kind, orderId),
  );
  const node = data[kind] ?? null;
  if (!node) return null;
  return {
    orderId: node.id,
    visualId: normalizeVisualId(node.visualId),
    statusId: node.status?.id ?? null,
    statusName: node.status?.name ?? null,
  };
}

/** Exact identity + source-status fence used immediately before side effects. */
export function liveOrderStatusMatches(
  observed: LiveOrderStatus | null,
  expected: { orderId: string; visualId: number; sourceStatusId: string },
): boolean {
  return (
    observed !== null &&
    observed.orderId === expected.orderId &&
    observed.visualId === expected.visualId &&
    observed.statusId === expected.sourceStatusId
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnsupportedStatusFilter(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes("statusids") &&
    (message.includes("unknown argument") ||
      message.includes("argument") ||
      message.includes("field") ||
      message.includes("cannot query"))
  );
}

function unsupportedFilterError(err: unknown): LiveDiscoveryError {
  return new LiveDiscoveryError(
    [
      "Printavo does not support status-scoped live discovery (statusIds)",
      "for this account/schema; auto-print was aborted before any fallback",
      "crawl. Verify the v2 schema or add a supported status filter before",
      "using an expensive historical workaround. Upstream error:",
      errorMessage(err),
    ].join(" "),
    "unsupported_filter",
  );
}

function invalidResponse(
  kind: OrderKind,
  page: number,
  reason: string,
): LiveDiscoveryError {
  return new LiveDiscoveryError(
    `Live auto-print discovery returned an invalid ${kind} page ${page}: ${reason}`,
    "invalid_response",
  );
}

function readConnection(
  kind: OrderKind,
  data: unknown,
  page: number,
): Connection<PvOrderNode> {
  const key = kind === "invoices" ? "invoices" : "quotes";
  const connection = (data as Record<string, unknown> | null | undefined)?.[key];
  if (!connection || typeof connection !== "object") {
    throw invalidResponse(kind, page, `missing ${key} connection`);
  }
  const value = connection as {
    nodes?: unknown;
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
  };
  if (!Array.isArray(value.nodes)) {
    throw invalidResponse(kind, page, "nodes is not an array");
  }
  if (
    !value.pageInfo ||
    typeof value.pageInfo.hasNextPage !== "boolean" ||
    (value.pageInfo.endCursor !== null &&
      typeof value.pageInfo.endCursor !== "string")
  ) {
    throw invalidResponse(kind, page, "pageInfo is incomplete");
  }
  return value as Connection<PvOrderNode>;
}

/**
 * Read every page of invoices and quotes that Printavo says currently has
 * one of the configured source statuses. There is intentionally no created-at
 * cutoff, visual-id cutoff, or early-stop heuristic here: a status transition
 * on an old invoice must be discoverable on the first run.
 *
 * `statusIds` is supported by the live v2 schema on both root connections
 * (verified with read-only introspection). If that capability disappears,
 * this function fails closed and does not fall back to a full historical
 * crawl.
 */
export async function discoverLiveAutoPrintOrders(
  statusIds: readonly string[],
  client: LiveOrderQueryClient = getPrintavoClient(),
): Promise<LiveDiscoveryResult> {
  const wantedStatuses = new Set(
    statusIds.filter((statusId) => statusId.trim().length > 0),
  );
  if (wantedStatuses.size === 0) {
    throw new LiveDiscoveryError(
      "Live auto-print discovery requires at least one source status",
      "invalid_response",
    );
  }

  const byVisual = new Map<number, LiveAutoPrintOrder>();
  const deadline = Date.now() + MAX_DISCOVERY_DURATION_MS;
  const pages: Record<"invoices" | "quotes", number> = {
    invoices: 0,
    quotes: 0,
  };

  for (const kind of ["invoices", "quotes"] as const) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const pageNumber = pages[kind] + 1;
      if (pageNumber > MAX_DISCOVERY_PAGES_PER_KIND || Date.now() >= deadline) {
        throw new LiveDiscoveryError(
          `Live auto-print discovery incomplete: exceeded the ${MAX_DISCOVERY_PAGES_PER_KIND}-page per-kind / ${MAX_DISCOVERY_DURATION_MS / 1000}-second budget. No documents were printed; narrow the configured source statuses and retry.`,
          "budget_exceeded",
        );
      }
      let data: InvoicesPage | QuotesPage;
      try {
        const query =
          kind === "invoices"
            ? invoicesPageQuery({
                after: cursor,
                statusIds: [...wantedStatuses],
                sortDescending: false,
              })
            : quotesPageQuery({
                after: cursor,
                statusIds: [...wantedStatuses],
                sortDescending: false,
              });
        // Timeout bounds the discovery phase even while the shared gateway
        // is queued/retrying. The remaining request is read-only; never start
        // another page or any side effects after the deadline.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          data = await Promise.race([
            client.query<InvoicesPage | QuotesPage>(query),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new LiveDiscoveryError(
                "Live auto-print discovery incomplete: time budget exceeded. No documents were printed; retry when Printavo is available.",
                "budget_exceeded",
              )), Math.max(0, deadline - Date.now()));
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (err) {
        if (err instanceof LiveDiscoveryError) throw err;
        if (isUnsupportedStatusFilter(err)) {
          throw unsupportedFilterError(err);
        }
        throw new LiveDiscoveryError(
          `Live auto-print discovery failed on ${kind} page ${pageNumber}: ${errorMessage(err)}`,
          "request",
        );
      }

      const page = readConnection(kind, data, pageNumber);
      // Printavo can report hasNextPage:false at its 10k window boundary.
      // Never label that response complete, even if upstream page sizes change.
      if (page.pageInfo.endCursor &&
          Number(Buffer.from(page.pageInfo.endCursor, "base64").toString("utf8")) >= 10_000) {
        throw new LiveDiscoveryError(
          "Live auto-print discovery incomplete: Printavo pagination window reached. No documents were printed.",
          "incomplete_pagination",
        );
      }
      pages[kind] = pageNumber;
      for (const rawNode of page.nodes) {
        if (!rawNode || typeof rawNode !== "object") {
          throw invalidResponse(kind, pageNumber, "a node is not an object");
        }
        const node = rawNode as PvOrderNode;
        if (typeof node.id !== "string" || node.id.length === 0) {
          throw invalidResponse(kind, pageNumber, "a node has no id");
        }
        // Printavo's GraphQL scalar has returned visualId as both a number
        // and a numeric string across accounts/replicas. Normalize the
        // response before it reaches the mirror and dedupe logic.
        const visualId = normalizeVisualId(
          (node as unknown as { visualId?: unknown }).visualId,
        );
        if (visualId === null) {
          throw invalidResponse(
            kind,
            pageNumber,
            `order ${node.id} has no integer visualId`,
          );
        }
        const normalizedNode = { ...node, visualId };
        if (
          !node.status ||
          typeof node.status.id !== "string" ||
          !wantedStatuses.has(node.status.id)
        ) {
          // Do not trust an API response that ignores the statusIds argument:
          // accepting it would reintroduce the stale-local-status bug.
          throw invalidResponse(
            kind,
            pageNumber,
            `order ${node.id} did not match the requested statusIds`,
          );
        }

        const existing = byVisual.get(visualId);
        // A quote can coexist briefly with its invoice during conversion. The
        // invoice is the printable/live winner; preserving one visual id here
        // also prevents two submissions in one run.
        if (!existing || (existing.kind === "quotes" && kind === "invoices")) {
          byVisual.set(visualId, { kind, node: normalizedNode });
        }
      }

      if (!page.pageInfo.hasNextPage) break;
      const nextCursor = page.pageInfo.endCursor;
      if (!nextCursor) {
        throw new LiveDiscoveryError(
          `Live auto-print discovery was incomplete: ${kind} page ${pageNumber} reported hasNextPage without an endCursor`,
          "incomplete_pagination",
        );
      }
      if (nextCursor === cursor) {
        throw new LiveDiscoveryError(
          `Live auto-print discovery was incomplete: ${kind} page ${pageNumber} repeated its cursor`,
          "incomplete_pagination",
        );
      }
      if (seenCursors.has(nextCursor)) {
        throw new LiveDiscoveryError(
          `Live auto-print discovery was incomplete: ${kind} pagination cursor cycle detected at ${nextCursor}`,
          "incomplete_pagination",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  return {
    orders: [...byVisual.values()].sort(
      (a, b) => a.node.visualId - b.node.visualId,
    ),
    pages,
  };
}