import type { Logger } from "pino";
import {
  changeEventsTable,
  db,
  pvLineItemsTable,
  pvOrdersTable,
} from "@workspace/db";
import {
  lineItemUpdateMutation,
  poPushLineItemQuery,
  type LineItemUpdateInput,
} from "@workspace/printavo";
import { and, eq, sql } from "drizzle-orm";
import { getPrintavoClient } from "../printavoGateway";
import { newDetailAgg, refreshOrderDetail } from "../sync/detail";

export type ProductStatusTarget = "unset" | "ordered" | "received";
export type ProductStatusOutcome =
  | "updated"
  | "already_set"
  | "conflict"
  | "failed"
  | "unknown";

export interface ProductStatusSelection {
  lineItemId: string;
  orderId: string;
}

export function normalizeUniqueSelections(
  selections: readonly ProductStatusSelection[],
): ProductStatusSelection[] | null {
  const normalized = selections.map((item) => ({
    lineItemId: item.lineItemId.trim(),
    orderId: item.orderId.trim(),
  }));
  if (
    normalized.some((item) => !item.lineItemId || !item.orderId) ||
    new Set(normalized.map((item) => item.lineItemId)).size !== normalized.length
  ) {
    return null;
  }
  return normalized;
}

export interface ProductStatusResult extends ProductStatusSelection {
  outcome: ProductStatusOutcome;
  message: string;
}

export interface BulkProductStatusResult {
  results: ProductStatusResult[];
  updated: number;
  alreadySet: number;
  failed: number;
}

interface LiveLineItem {
  id: string;
  position: number | null;
  productStatus?: unknown;
}

interface MutationData {
  lineItemUpdate: {
    id: string;
    productStatus?: unknown;
  } | null;
}

interface LockedMirror {
  orderType: string;
  visualId: number;
  mirrorStatus: string | null;
  confirm(status: string | null): Promise<boolean>;
}

export interface ProductStatusDependencies {
  query<T>(document: string): Promise<T>;
  mutate<T>(document: string): Promise<T>;
  withItemLock<T>(
    lineItemId: string,
    orderId: string,
    work: (mirror: LockedMirror | null) => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }>;
  refreshOrder(orderId: string, orderType: string, logger: Logger): Promise<void>;
}

function targetValue(target: ProductStatusTarget): string | null {
  return target === "unset" ? null : target;
}

function explicitStatus(
  value: { productStatus?: unknown },
): { valid: true; status: string | null } | { valid: false } {
  if (!Object.prototype.hasOwnProperty.call(value, "productStatus")) {
    return { valid: false };
  }
  if (value.productStatus === null || typeof value.productStatus === "string") {
    return { valid: true, status: value.productStatus };
  }
  return { valid: false };
}

function sameStatus(a: string | null, b: string | null): boolean {
  return a === b;
}

async function defaultWithItemLock<T>(
  lineItemId: string,
  orderId: string,
  work: (mirror: LockedMirror | null) => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  return db.transaction(async (tx) => {
    const lockResult = await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${lineItemId}, 719204)
      ) AS acquired
    `);
    if (lockResult.rows[0]?.["acquired"] !== true) return { acquired: false };

    const [row] = await tx
      .select({
        orderType: pvOrdersTable.orderType,
        visualId: pvOrdersTable.visualId,
        mirrorStatus: pvLineItemsTable.productStatus,
      })
      .from(pvLineItemsTable)
      .innerJoin(
        pvOrdersTable,
        eq(pvOrdersTable.printavoId, pvLineItemsTable.orderId),
      )
      .where(
        and(
          eq(pvLineItemsTable.printavoId, lineItemId),
          eq(pvLineItemsTable.orderId, orderId),
        ),
      )
      .limit(1)
      .for("update", { of: pvLineItemsTable });

    const mirror: LockedMirror | null = row
      ? {
          ...row,
          async confirm(status): Promise<boolean> {
            const now = new Date();
            const updated = await tx
              .update(pvLineItemsTable)
              .set({ productStatus: status, syncedAt: now })
              .where(
                and(
                  eq(pvLineItemsTable.printavoId, lineItemId),
                  eq(pvLineItemsTable.orderId, orderId),
                ),
              )
              .returning({ id: pvLineItemsTable.printavoId });
            if (updated.length === 0) return false;
            if (!sameStatus(row.mirrorStatus, status)) {
              await tx.insert(changeEventsTable).values({
                entityType: "line_item",
                entityId: lineItemId,
                orderId,
                visualId: row.visualId,
                eventType: "status_change",
                field: "productStatus",
                oldValue: row.mirrorStatus,
                newValue: status,
                occurredAt: now,
              });
            }
            return true;
          },
        }
      : null;
    return { acquired: true, value: await work(mirror) };
  });
}

function defaultDependencies(): ProductStatusDependencies {
  const client = getPrintavoClient();
  return {
    query: (document) => client.query(document),
    mutate: (document) => client.mutate(document),
    withItemLock: defaultWithItemLock,
    refreshOrder: async (orderId, _orderType, logger) => {
      const [order] = await db
        .select({ orderType: pvOrdersTable.orderType })
        .from(pvOrdersTable)
        .where(eq(pvOrdersTable.printavoId, orderId))
        .limit(1);
      if (!order) throw new Error("Order is no longer present in the local mirror");
      await refreshOrderDetail(
        orderId,
        order.orderType === "quote" ? "quotes" : "invoices",
        newDetailAgg(),
        logger,
      );
    },
  };
}

async function reconcile(
  selection: ProductStatusSelection,
  desired: string | null,
  deps: ProductStatusDependencies,
): Promise<boolean> {
  try {
    const data = await deps.query<{ lineItem: LiveLineItem | null }>(
      poPushLineItemQuery(selection.lineItemId),
    );
    const status = data.lineItem ? explicitStatus(data.lineItem) : null;
    return Boolean(
      data.lineItem &&
        data.lineItem.id === selection.lineItemId &&
        status?.valid &&
        status.status === desired,
    );
  } catch {
    return false;
  }
}

async function processOne(
  selection: ProductStatusSelection,
  target: ProductStatusTarget,
  deps: ProductStatusDependencies,
): Promise<ProductStatusResult> {
  const desired = targetValue(target);
  let confirmedOutcome: "updated" | "already_set" | null = null;
  let locked: { acquired: boolean; value?: ProductStatusResult };
  try {
    locked = await deps.withItemLock(
      selection.lineItemId,
      selection.orderId,
      async (mirror): Promise<ProductStatusResult> => {
      if (!mirror) {
        return {
          ...selection,
          outcome: "conflict",
          message: "Line item is not a member of the selected order.",
        };
      }

      let live: LiveLineItem | null;
      try {
        const data = await deps.query<{ lineItem: LiveLineItem | null }>(
          poPushLineItemQuery(selection.lineItemId),
        );
        live = data.lineItem;
      } catch {
        return {
          ...selection,
          outcome: "failed",
          message: "Could not safely read the current Printavo line item.",
        };
      }
      if (!live || live.id !== selection.lineItemId) {
        return {
          ...selection,
          outcome: "failed",
          message: "Line item was not found in Printavo.",
        };
      }
      const liveStatus = explicitStatus(live);
      if (!liveStatus.valid) {
        return {
          ...selection,
          outcome: "failed",
          message: "Printavo did not return a valid current product status.",
        };
      }
      if (sameStatus(liveStatus.status, desired)) {
        confirmedOutcome = "already_set";
        const mirrored = await mirror.confirm(desired);
        return {
          ...selection,
          outcome: "already_set",
          message: mirrored
            ? "Product status was already set."
            : "Product status was already set; local mirror refresh is pending.",
        };
      }
      if (liveStatus.status !== "need_ordering") {
        return {
          ...selection,
          outcome: "conflict",
          message: `Product status changed to "${liveStatus.status ?? "unset"}"; it was not overwritten.`,
        };
      }
      if (!Number.isInteger(live.position)) {
        return {
          ...selection,
          outcome: "failed",
          message: "Printavo did not return the required line-item position.",
        };
      }
      const position = live.position as number;

      const input: LineItemUpdateInput = {
        position,
        productStatus: desired,
      };
      try {
        const data = await deps.mutate<MutationData>(
          lineItemUpdateMutation(selection.lineItemId, input),
        );
        const returnedStatus = data.lineItemUpdate
          ? explicitStatus(data.lineItemUpdate)
          : { valid: false as const };
        const confirmed =
          data.lineItemUpdate?.id === selection.lineItemId &&
          returnedStatus.valid &&
          returnedStatus.status === desired;
        if (!confirmed && !(await reconcile(selection, desired, deps))) {
          return {
            ...selection,
            outcome: "unknown",
            message: "Printavo did not confirm the update; verify the line item before retrying.",
          };
        }
      } catch {
        if (!(await reconcile(selection, desired, deps))) {
          return {
            ...selection,
            outcome: "unknown",
            message: "The update outcome is unknown; verify the line item in Printavo before retrying.",
          };
        }
      }

      confirmedOutcome = "updated";
      const mirrored = await mirror.confirm(desired);
      return {
        ...selection,
        outcome: "updated",
        message: mirrored
          ? "Product status updated."
          : "Printavo updated; local mirror refresh is pending.",
      };
      },
    );
  } catch {
    return {
      ...selection,
      outcome: confirmedOutcome ?? "failed",
      message:
        confirmedOutcome === "updated"
          ? "Printavo updated; local mirror refresh is pending."
          : confirmedOutcome === "already_set"
            ? "Product status was already set; local mirror refresh is pending."
            : "The line item could not be updated safely.",
    };
  }

  if (!locked.acquired) {
    return {
      ...selection,
      outcome: "conflict",
      message: "Another update for this line item is in progress.",
    };
  }
  return locked.value!;
}

export async function bulkSetProductStatus(
  selections: readonly ProductStatusSelection[],
  target: ProductStatusTarget,
  logger: Logger,
  dependencies?: ProductStatusDependencies,
): Promise<BulkProductStatusResult> {
  const deps = dependencies ?? defaultDependencies();
  const results: ProductStatusResult[] = [];
  const refreshOrders = new Map<string, string>();

  for (const selection of selections) {
    const result = await processOne(selection, target, deps);
    results.push(result);
    logger.info(
      {
        lineItemId: selection.lineItemId,
        orderId: selection.orderId,
        target,
        outcome: result.outcome,
      },
      "purchasing line-item product status",
    );
    if (result.outcome === "updated" || result.outcome === "already_set") {
      // The order type is looked up again by the refresh implementation. This
      // value only selects the invoice/quote GraphQL root in injected tests.
      refreshOrders.set(selection.orderId, "invoice");
    }
  }

  if (refreshOrders.size > 0) {
    setImmediate(() => {
      for (const [orderId, orderType] of refreshOrders) {
        void deps.refreshOrder(orderId, orderType, logger).catch((err: unknown) => {
          logger.warn(
            { err, orderId },
            "Product status succeeded but asynchronous order detail refresh failed",
          );
        });
      }
    });
  }

  return {
    results,
    updated: results.filter((r) => r.outcome === "updated").length,
    alreadySet: results.filter((r) => r.outcome === "already_set").length,
    failed: results.filter(
      (r) =>
        r.outcome === "failed" ||
        r.outcome === "conflict" ||
        r.outcome === "unknown",
    ).length,
  };
}