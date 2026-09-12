import { useEffect, useRef, useState } from "react";
import { Activity, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import {
  getOrderActivity,
  type GetOrderActivityParams,
  type OrderActivityDetail,
  type OrderActivityEvent,
} from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";

type ActivityCategory = keyof OrderActivityDetail["totals"]["byCategory"];

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  quantity: "Qty",
  lineItem: "Line Item",
  price: "Price",
  balance: "Balance / payment",
  status: "Status",
  order: "Other order changes",
};
const CATEGORY_KEYS: ActivityCategory[] = [
  "quantity",
  "lineItem",
  "price",
  "balance",
  "status",
  "order",
];

function formatObservedAt(value: string | null): string {
  if (!value) return "Unknown observation time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown observation time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatQuantity(value: unknown): string {
  if (!value || typeof value !== "object") {
    return value == null ? "—" : String(value);
  }
  const record = value as { items?: unknown; sizes?: unknown };
  const items =
    typeof record.items === "number" ? formatNumber(record.items) : "—";
  if (!Array.isArray(record.sizes)) return items;
  const sizes = record.sizes
    .map((size) => {
      if (!size || typeof size !== "object") return null;
      const item = size as { size?: unknown; count?: unknown };
      return `${String(item.size ?? "size")}: ${String(item.count ?? "—")}`;
    })
    .filter(Boolean)
    .join(", ");
  return sizes ? `${items} (${sizes})` : items;
}

const UTC_DATE_FIELDS = new Set([
  "invoiceAt",
  "customerDueAt",
  "productionDueAt",
  "paymentDueAt",
]);

function formatUtcCalendarDate(value: unknown): string {
  if (typeof value !== "string") return value == null ? "—" : String(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatProductStatus(value: unknown): string {
  if (value == null) return "—";
  if (typeof value !== "string") return String(value);
  const labels: Record<string, string> = {
    need_ordering: "Need ordering",
    in_production: "In production",
    ready_to_ship: "Ready to ship",
  };
  return (
    labels[value] ??
    value
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ")
  );
}

function formatActivityValue(field: string | null, value: unknown): string {
  if (value == null) return "—";
  if (field === "quantity") return formatQuantity(value);
  if (field === "productStatus") return formatProductStatus(value);
  if (field && UTC_DATE_FIELDS.has(field)) {
    return formatUtcCalendarDate(value);
  }
  if (
    field === "unitPrice" ||
    field === "total" ||
    field === "amountOutstanding"
  ) {
    const amount = Number(value);
    return Number.isFinite(amount) ? formatMoney(amount) : String(value);
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const concise = [
      record.description,
      record.itemNumber,
      record.name,
      record.brand,
      record.color,
      record.id,
    ].filter(
      (item): item is string | number =>
        typeof item === "string" || typeof item === "number",
    );
    if (concise.length > 0) return concise.join(" · ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function lineItemIdentity(event: OrderActivityEvent): string | null {
  if (event.entityType !== "line_item" || !event.entityId) return null;
  const values = [event.newValue, event.oldValue];
  const item = values.find(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
  const description =
    item &&
    [item.description, item.itemNumber, item.name].find(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    );
  return description
    ? `${String(description)} · Line ID ${event.entityId}`
    : `Line ID ${event.entityId}`;
}

function EventValues({ event }: { event: OrderActivityEvent }) {
  const unspecified =
    event.eventType === "updated" && !event.field;
  if (unspecified) {
    return (
      <div className="mt-2 rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
        Unspecified update — no field-level before/after values were recorded.
      </div>
    );
  }

  if (event.eventType === "created" || event.eventType === "deleted") {
    const value =
      event.eventType === "created" ? event.newValue : event.oldValue;
    return (
      <div className="mt-2 rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
        {formatActivityValue(event.field, value)}
      </div>
    );
  }

  if (
    event.oldValue === null &&
    event.newValue === null &&
    event.eventType !== "status_change"
  ) {
    return (
      <div className="mt-2 text-xs italic text-slate-500">
        No before/after values were recorded.
      </div>
    );
  }

  return (
    <div className="mt-2 grid gap-2 text-xs sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
      <div className="rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-red-200">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-red-400/70">
          Before
        </div>
        {formatActivityValue(event.field, event.oldValue)}
      </div>
      <ChevronRight className="hidden self-center text-slate-600 sm:block" size={16} />
      <div className="rounded border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-emerald-200">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-400/70">
          After
        </div>
        {formatActivityValue(event.field, event.newValue)}
      </div>
    </div>
  );
}

export function ActivityOrderDetailPanel({
  orderId,
  visualId,
  invoiceAt,
  open,
  activityStart,
  activityEnd,
  activityOwner,
  onOpenChange,
}: {
  orderId: string | null;
  visualId: number | null;
  invoiceAt: string | null;
  open: boolean;
  activityStart: string;
  activityEnd: string;
  activityOwner: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<OrderActivityDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  async function loadPage(
    beforeId?: number | null,
    append = false,
    generation = generationRef.current,
  ): Promise<void> {
    if (!orderId) return;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    const params: GetOrderActivityParams = {
      activityStart: activityStart || undefined,
      activityEnd: activityEnd || undefined,
      activityOwner: activityOwner || undefined,
      limit: 25,
      beforeId: beforeId ?? undefined,
    };
    try {
      const page = await getOrderActivity(orderId, params);
      if (!mountedRef.current || generation !== generationRef.current) return;
      setData((previous) => {
        if (!append || !previous) return page;
        const existingIds = new Set(previous.events.map((event) => event.id));
        const newEvents = page.events.filter(
          (event) => !existingIds.has(event.id),
        );
        return {
          ...page,
          events: [...previous.events, ...newEvents],
        };
      });
    } catch (err: unknown) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : "Could not load activity");
    } finally {
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }

  useEffect(() => {
    // Do not fetch until the user opens the panel. Filter changes while it is
    // open intentionally restart the first bounded page so totals reconcile.
    const generation = ++generationRef.current;
    setLoading(false);
    setLoadingMore(false);
    if (!open || !orderId) return;
    setData(null);
    setLoading(true);
    void loadPage(undefined, false, generation);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId, activityStart, activityEnd, activityOwner, reload]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto border-slate-800 bg-slate-950 text-slate-100 sm:max-w-2xl"
      >
        <SheetHeader className="pr-8 text-left">
          <SheetTitle className="flex items-center gap-2 text-white">
            <Activity className="text-[#10b981]" size={20} />
            Activity detail {visualId != null ? `· #${visualId}` : ""}
          </SheetTitle>
          <SheetDescription className="text-slate-400">
            Qualifying changes observed in the local mirror. Observation times
            are shown in Eastern time; no upstream Printavo request is made.
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="mr-2 animate-spin text-[#10b981]" size={20} />
            Loading activity…
          </div>
        )}

        {!loading && error && (
          <div className="mt-6 rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300">
            <div className="flex items-start justify-between gap-4">
              <span>{error}</span>
              <button
                type="button"
                data-testid="button-retry-activity"
                onClick={() => setReload((value) => value + 1)}
                className="inline-flex shrink-0 items-center gap-1 text-red-200 hover:text-white"
              >
                <RefreshCw size={14} /> Retry
              </button>
            </div>
          </div>
        )}

        {!loading && !error && data && (
          <div className="mt-6 space-y-5">
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="font-medium text-slate-200">
                  {data.order.orderType}
                </span>
                <span>
                  Invoice date:{" "}
                  {formatUtcCalendarDate(invoiceAt ?? data.order.invoiceAt)}
                </span>
                <span>Order: {data.order.id}</span>
              </div>
              <div className="mt-2">
                Observed range:{" "}
                <span className="text-slate-200">
                  {data.range.start ? formatDate(data.range.start) : "All observed dates"}{" "}
                  {data.range.end ? `to ${formatDate(data.range.end)}` : ""}
                </span>
                {data.order.ownerEmail && (
                  <span className="ml-3">
                    Current owner:{" "}
                    <span className="text-slate-200">{data.order.ownerEmail}</span>
                  </span>
                )}
              </div>
            </div>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">
                  Category totals
                </h3>
                <span className="font-mono text-sm text-[#10b981]">
                  {formatNumber(data.totals.changes)} changes
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CATEGORY_KEYS.map((category) => (
                  <div
                    key={category}
                    data-testid={`activity-category-${category}`}
                    className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {CATEGORY_LABELS[category]}
                    </div>
                    <div className="mt-1 font-mono text-lg font-bold text-white">
                      {formatNumber(data.totals.byCategory[category])}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-white">
                Qualifying events
              </h3>
              {data.events.length === 0 ? (
                <p className="rounded-lg border border-slate-800 p-5 text-sm text-slate-500">
                  No qualifying changes were observed in this report range.
                </p>
              ) : (
                <div className="space-y-2">
                  {data.events.map((event) => (
                    <article
                      key={event.id}
                      data-testid={`activity-event-${event.id}`}
                      className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-slate-200">
                            {event.fieldLabel}
                          </div>
                          {lineItemIdentity(event) && (
                            <div className="mt-1 font-mono text-[10px] text-slate-500">
                              {lineItemIdentity(event)}
                            </div>
                          )}
                          <div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-wider text-slate-500">
                            <span className="rounded bg-emerald-950/50 px-1.5 py-0.5 text-emerald-300">
                              {CATEGORY_LABELS[event.category]}
                            </span>
                            <span>{event.eventType.replace("_", " ")}</span>
                          </div>
                        </div>
                        <time className="text-[11px] text-slate-500">
                          {formatObservedAt(event.occurredAt)}
                        </time>
                      </div>
                      <EventValues event={event} />
                    </article>
                  ))}
                </div>
              )}
              {data.pagination.hasMore && (
                <button
                  type="button"
                  data-testid="button-load-more-activity"
                  disabled={loadingMore}
                  onClick={() =>
                    void loadPage(data.pagination.nextBeforeId, true)
                  }
                  className="mt-3 inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50"
                >
                  {loadingMore && <Loader2 className="animate-spin" size={14} />}
                  {loadingMore ? "Loading older changes…" : "Load more"}
                </button>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}