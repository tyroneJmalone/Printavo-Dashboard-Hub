import type { ReportOrder } from "./dataset";

const SHOP_TIME_ZONE = "America/New_York";
export type ActivityEntityType = "order" | "line_item";
export type ActivityEventType =
  | "created"
  | "deleted"
  | "status_change"
  | "field_change"
  | "updated"
  | "converted";

export const ACTIVITY_CATEGORIES = [
  "quantity",
  "lineItem",
  "price",
  "status",
  "order",
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export type ActivityBreakdown = Record<ActivityCategory, number>;

export function emptyActivityBreakdown(): ActivityBreakdown {
  return {
    quantity: 0,
    lineItem: 0,
    price: 0,
    status: 0,
    order: 0,
  };
}

export interface ReportActivityEvent {
  entityType: ActivityEntityType;
  entityId: string | null;
  orderId: string | null;
  eventType: ActivityEventType;
  field?: string | null;
  occurredAt: Date | string;
}

export interface AggregatedActivity {
  orderId: string;
  changes: number;
  latestObservedAt: string;
  breakdown: ActivityBreakdown;
}

/**
 * Activity intentionally excludes order creation/conversion and snapshots.
 * Snapshots are baselines, while these are the persisted change_events that
 * represent an observed change. Line-item creation/deletion are changes even
 * though they do not have a legacy order equivalent.
 */
export function isQualifyingActivityEvent(event: ReportActivityEvent): boolean {
  if (event.entityType === "order") {
    return (
      event.entityId !== null &&
      ["status_change", "field_change", "updated"].includes(event.eventType)
    );
  }
  return (
    event.orderId !== null &&
    ["status_change", "field_change", "created", "deleted"].includes(
      event.eventType,
    )
  );
}

/** Legacy order events identify their order by entity_id; line events use order_id. */
export function activityOrderId(
  event: ReportActivityEvent,
): string | null {
  if (!isQualifyingActivityEvent(event)) return null;
  return event.entityType === "order" ? event.entityId : event.orderId;
}

/**
 * Every qualifying event maps to exactly one category. These names mirror the
 * fields emitted by the sync engine (line-item quantity/unitPrice/productStatus
 * and order total/amountOutstanding) rather than guessing from free-form JSON.
 */
export function activityCategory(event: Pick<
  ReportActivityEvent,
  "entityType" | "eventType" | "field"
>): ActivityCategory {
  if (event.eventType === "status_change" || event.field === "productStatus") {
    return "status";
  }
  if (event.field === "quantity") return "quantity";
  if (
    event.field === "unitPrice" ||
    event.field === "total" ||
    event.field === "amountOutstanding"
  ) {
    return "price";
  }
  if (event.entityType === "line_item") return "lineItem";
  return "order";
}

function localDate(value: Date | string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

/** Inclusive shop-local date boundary check for an observed event. */
export function isActivityInRange(
  event: Pick<ReportActivityEvent, "occurredAt">,
  start: string | null,
  end: string | null,
): boolean {
  const day = localDate(event.occurredAt);
  return (!start || day >= start) && (!end || day <= end);
}

/**
 * Aggregate event rows without joining line items. This mirrors the SQL CTE
 * used by the report and is useful for boundary/count regression tests.
 */
export function aggregateActivity(
  events: readonly ReportActivityEvent[],
  start: string | null = null,
  end: string | null = null,
): AggregatedActivity[] {
  const byOrder = new Map<
    string,
    { changes: number; latest: Date; breakdown: ActivityBreakdown }
  >();
  for (const event of events) {
    const orderId = activityOrderId(event);
    if (
      !orderId ||
      !isActivityInRange(event, start, end)
    ) {
      continue;
    }
    const at =
      typeof event.occurredAt === "string"
        ? new Date(event.occurredAt)
        : event.occurredAt;
    const previous = byOrder.get(orderId);
    if (!previous) {
      const breakdown = emptyActivityBreakdown();
      breakdown[activityCategory(event)] = 1;
      byOrder.set(orderId, { changes: 1, latest: at, breakdown });
    } else {
      previous.changes += 1;
      previous.breakdown[activityCategory(event)] += 1;
      if (at > previous.latest) previous.latest = at;
    }
  }
  return [...byOrder.entries()]
    .map(([orderId, value]) => ({
      orderId,
      changes: value.changes,
      latestObservedAt: value.latest.toISOString(),
      breakdown: value.breakdown,
    }))
    .sort(
      (a, b) =>
        b.latestObservedAt.localeCompare(a.latestObservedAt) ||
        b.orderId.localeCompare(a.orderId),
    );
}

export function currentOwnerMatches(
  currentOwner: string | null,
  requestedOwner: string | null,
): boolean {
  if (!requestedOwner) return true;
  return (currentOwner ?? "").trim().toLowerCase() === requestedOwner.trim().toLowerCase();
}

export function paginateReportRows<T>(
  rows: readonly T[],
  offset: number,
  limit: number,
): T[] {
  return rows.slice(Math.max(0, Math.trunc(offset)), Math.max(0, Math.trunc(offset)) + Math.max(1, Math.trunc(limit)));
}

/** Stable API envelope for the paginated list (never omit matching orders). */
export function serializeReportOrder(order: ReportOrder) {
  return {
    id: order.id,
    visualId: order.visualId,
    orderType: order.orderType,
    statusName: order.statusName,
    nickname: order.nickname,
    customerName: order.customerName,
    ownerEmail: order.ownerEmail,
    total: order.total,
    qty: order.qty,
    createdAt: order.createdAt,
    invoiceAt: order.invoiceAt,
    productionDueAt: order.productionDueAt,
    dueAt: order.dueAt,
    activityCount: order.activityCount,
    latestActivityAt: order.latestActivityAt,
    activityBreakdown: order.activityBreakdown,
  };
}
