import type {
  NeedsOrderingLineItem,
  NeedsOrderingOrder,
} from "@workspace/api-client-react";
import { guessVendor, type CartItem } from "@/stores/poCart";

export const EASTERN_TIMEZONE = "America/New_York";

export type UrgencyReason =
  | { kind: "nickname"; label: string }
  | { kind: "overdue"; label: string }
  | { kind: "due-soon"; label: string; businessDays: number };

export interface OrderUrgency {
  urgent: boolean;
  reasons: UrgencyReason[];
  /** Valid Printavo calendar-date key, used only to rank urgent orders. */
  dueDateKey: string | null;
  overdue: boolean;
}

const NICKNAME_TERMS = [
  { label: "RUSH", pattern: /(?:^|[^a-z0-9])rush(?:$|[^a-z0-9])/i },
  { label: "FIRM", pattern: /(?:^|[^a-z0-9])firm(?:$|[^a-z0-9])/i },
  { label: "DEADLINE", pattern: /(?:^|[^a-z0-9])deadline(?:$|[^a-z0-9])/i },
  { label: "ASAP", pattern: /(?:^|[^a-z0-9])asap(?:$|[^a-z0-9])/i },
] as const;

function dateKeyInEastern(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * Printavo due dates are calendar dates represented at UTC midnight. Extract
 * and validate the date portion without converting it into the browser's zone.
 */
export function printavoDateKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function calendarDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Business days from today (exclusive) through due date (inclusive), Mon–Fri. */
export function weekdayDistance(fromKey: string, toKey: string): number {
  const from = calendarDate(fromKey);
  const to = calendarDate(toKey);
  if (to.getTime() <= from.getTime()) return 0;
  let days = 0;
  const cursor = new Date(from);
  while (cursor.getTime() < to.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days++;
  }
  return days;
}

export function getOrderUrgency(
  order: Pick<NeedsOrderingOrder, "nickname" | "productionDueAt">,
  now: Date = new Date(),
): OrderUrgency {
  const reasons: UrgencyReason[] = [];
  const nickname = order.nickname ?? "";
  for (const term of NICKNAME_TERMS) {
    if (term.pattern.test(nickname)) {
      reasons.push({ kind: "nickname", label: `${term.label} in nickname` });
    }
  }

  const dueDateKey = printavoDateKey(order.productionDueAt);
  let overdue = false;
  if (dueDateKey) {
    const todayKey = dateKeyInEastern(now);
    overdue = dueDateKey < todayKey;
    if (overdue) {
      reasons.push({ kind: "overdue", label: "Production overdue" });
    } else {
      const businessDays = weekdayDistance(todayKey, dueDateKey);
      if (businessDays <= 7) {
        reasons.push({
          kind: "due-soon",
          label:
            businessDays === 0
              ? "Production due today"
              : `Production due in ${businessDays} business day${businessDays === 1 ? "" : "s"}`,
          businessDays,
        });
      }
    }
  }
  return { urgent: reasons.length > 0, reasons, dueDateKey, overdue };
}

/** Urgent first; overdue first within urgent, then nearest valid due date. */
export function sortOrdersByUrgency<T extends Pick<NeedsOrderingOrder, "nickname" | "productionDueAt">>(
  orders: T[],
  now: Date = new Date(),
): T[] {
  return orders
    .map((order, index) => ({ order, index, urgency: getOrderUrgency(order, now) }))
    .sort((a, b) => {
      if (a.urgency.urgent !== b.urgency.urgent) return a.urgency.urgent ? -1 : 1;
      if (!a.urgency.urgent) return a.index - b.index;
      if (a.urgency.overdue !== b.urgency.overdue) return a.urgency.overdue ? -1 : 1;
      const aDue = a.urgency.dueDateKey;
      const bDue = b.urgency.dueDateKey;
      if (aDue && bDue && aDue !== bDue) return aDue.localeCompare(bDue);
      if (aDue !== bDue) return aDue ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ order }) => order);
}

export function formatPrintavoCalendarDate(raw: string | null | undefined): string {
  const key = printavoDateKey(raw);
  if (!key) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(calendarDate(key));
}

export function buildCartItem(
  order: NeedsOrderingOrder,
  li: NeedsOrderingLineItem,
): CartItem {
  const sizes =
    li.sizes.length > 0
      ? li.sizes.map((size) => ({
          size: size.size,
          qty: size.count,
          unitCost: null,
          sku: null,
          inventoryKey: null,
          sizeIndex: null,
          vendorSize: null,
        }))
      : [{
          size: "OSFA",
          qty: li.items > 0 ? li.items : 0,
          unitCost: null,
          sku: null,
          inventoryKey: null,
          sizeIndex: null,
          vendorSize: null,
        }];
  return {
    key: li.id,
    printavoLineItemId: li.id,
    printavoOrderId: order.orderId,
    visualId: order.visualId,
    invoiceNickname: order.nickname,
    productionDueAt: order.productionDueAt,
    styleNumber: li.itemNumber ?? "",
    color: li.color,
    description: li.description,
    brand: li.brand,
    vendor: guessVendor(li.brand),
    vendorCatalogColor: null,
    vendorStyleId: null,
    resolved: false,
    sizes,
    inventory: null,
    warehouseCode: null,
    warehouseName: null,
    warehouseManual: false,
  };
}