const SHOP_TIME_ZONE = "America/New_York";

export type ActivityEntityType = "order" | "line_item";
export type ActivityEventType =
  | "created"
  | "deleted"
  | "status_change"
  | "field_change"
  | "updated"
  | "converted";

export interface ReportActivityEvent {
  entityType: ActivityEntityType;
  entityId: string | null;
  orderId: string | null;
  eventType: ActivityEventType;
  occurredAt: Date | string;
}

export interface AggregatedActivity {
  orderId: string;
  changes: number;
  latestObservedAt: string;
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
  const byOrder = new Map<string, { changes: number; latest: Date }>();
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
      byOrder.set(orderId, { changes: 1, latest: at });
    } else {
      previous.changes += 1;
      if (at > previous.latest) previous.latest = at;
    }
  }
  return [...byOrder.entries()]
    .map(([orderId, value]) => ({
      orderId,
      changes: value.changes,
      latestObservedAt: value.latest.toISOString(),
    }))
    .sort((a, b) => b.latestObservedAt.localeCompare(a.latestObservedAt));
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
