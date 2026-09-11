import { useEffect, useState } from "react";
import { History, Loader2, RefreshCw, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMoney, formatNumber } from "@/lib/format";
import type { PrintavoOrderHistory } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";

type HistoryValue = unknown;

type HistoryEvent = PrintavoOrderHistory["events"][number];
type CurrentLineItem = PrintavoOrderHistory["currentItems"][number];
type HistoryData = PrintavoOrderHistory;

function formatObservedAt(value: string | null | undefined): string {
  if (!value) return "Unknown observation time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown observation time";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatQuantity(value: HistoryValue): string {
  if (!value || typeof value !== "object") return value == null ? "—" : String(value);
  const record = value as { items?: unknown; sizes?: unknown };
  const items = typeof record.items === "number" ? formatNumber(record.items) : "—";
  const sizes = Array.isArray(record.sizes)
    ? record.sizes
        .map((size) => {
          if (!size || typeof size !== "object") return null;
          const item = size as { size?: unknown; count?: unknown };
          return `${String(item.size ?? "size")}: ${String(item.count ?? "—")}`;
        })
        .filter(Boolean)
        .join(", ")
    : "";
  return sizes ? `${items} (${sizes})` : items;
}

function formatValue(field: string | null, value: HistoryValue): string {
  if (value == null) return "—";
  if (field === "quantity") return formatQuantity(value);
  if (field === "unitPrice") {
    const amount = Number(value);
    return Number.isFinite(amount) ? formatMoney(amount) : String(value);
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("id" in record || "brand" in record || "itemNumber" in record) {
      return [record.itemNumber, record.id, record.brand]
        .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
        .join(" · ") || "—";
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function eventTitle(event: HistoryEvent): string {
  if (event.eventType === "created") return "Line added";
  if (event.eventType === "deleted") return "Line removed";
  if (event.eventType === "status_change") return "Product status changed";
  if (event.field === "quantity") return "Quantity changed";
  if (event.field === "unitPrice") return "Unit price changed";
  if (event.field === "description") return "Description changed";
  if (event.field === "product") return "Product changed";
  if (event.field === "color") return "Color changed";
  return event.field ? `${event.field} changed` : "Line item changed";
}

function itemLabel(item: CurrentLineItem): string {
  return item.description || item.itemNumber || item.productId || item.color || "Line item";
}

export function OrderLineItemHistory({
  orderId,
  visualId,
  open,
  onOpenChange,
}: {
  orderId: string | null;
  visualId: number | string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  async function loadPage(
    cursor: { beforeSnapshotId?: number | null; beforeEventId?: number | null } = {},
    append = false,
  ) {
    if (!orderId) return;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (cursor.beforeSnapshotId) {
        params.set("beforeSnapshotId", String(cursor.beforeSnapshotId));
      }
      if (cursor.beforeEventId) {
        params.set("beforeEventId", String(cursor.beforeEventId));
      }
      const page = await apiFetch<HistoryData>(
        `/printavo/orders/${encodeURIComponent(orderId)}/history?${params.toString()}`,
      );
      setData((previous) => {
        if (!append || !previous) return page;
        return {
          ...page,
          currentItems: previous.currentItems,
          baselineObservedAt: previous.baselineObservedAt,
          lineItemLabels: { ...previous.lineItemLabels, ...page.lineItemLabels },
          observations: [...previous.observations, ...page.observations],
          events: [...previous.events, ...page.events],
        };
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not load history");
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !orderId) return;
    setData(null);
    void loadPage();
    // A new open/order or explicit retry starts a fresh bounded page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId, reload]);

  const lineEvents =
    data?.events.filter((event) => event.entityType === "line_item") ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-950 border-slate-800 text-slate-100 max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <History className="text-[#10b981]" size={20} />
            Line-item history {visualId != null ? `· #${visualId}` : ""}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Complete Printavo detail observations only. The first observation
            establishes a baseline and is not shown as a change; times below
            are when Hub observed the difference, not when it was edited.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="mr-2 animate-spin text-[#10b981]" size={20} />
            Loading line-item history…
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300">
            <div className="flex items-start justify-between gap-4">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
                className="inline-flex shrink-0 items-center gap-1 text-red-200 hover:text-white"
              >
                <RefreshCw size={14} /> Retry
              </button>
            </div>
          </div>
        )}

        {!loading && !error && data && (
          <div className="space-y-5">
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
              {data.order.detailSyncState === "incomplete" && (
                <div className="mb-2 rounded border border-amber-800/60 bg-amber-950/30 p-2 text-amber-300">
                  History is incomplete because Printavo returned a nested
                  connection beyond the supported pagination limits.
                  {data.order.detailSyncError && ` ${data.order.detailSyncError}.`}
                </div>
              )}
              {data.baselineObservedAt
                ? `Baseline captured ${formatObservedAt(data.baselineObservedAt)}.`
                : "No complete detail observation is available yet. The next successful sync will establish the baseline."}
              {data.order.detailSyncedAt && (
                <span> Last detail sync: {formatObservedAt(data.order.detailSyncedAt)}.</span>
              )}
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-white">Current line items</h3>
              {data.currentItems.length === 0 ? (
                <p className="rounded-lg border border-slate-800 p-5 text-sm text-slate-500">
                  No line items in the latest complete observation.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900 text-slate-400">
                      <tr>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2">Color</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                        <th className="px-3 py-2">Sizes</th>
                        <th className="px-3 py-2 text-right">Unit price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {data.currentItems.map((item) => (
                        <tr key={item.lineItemId}>
                          <td className="px-3 py-2 text-slate-200">
                            <div>{itemLabel(item)}</div>
                            {item.itemNumber && (
                              <div className="font-mono text-[10px] text-slate-500">
                                {item.itemNumber}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-400">{item.color || "—"}</td>
                          <td className="px-3 py-2 text-right text-slate-200">
                            {formatNumber(item.items ?? 0)}
                          </td>
                          <td className="px-3 py-2 text-slate-400">
                            {item.sizes?.length
                              ? item.sizes.map((size) => `${size.size}: ${size.count}`).join(", ")
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-200">
                            {item.price == null ? "—" : formatMoney(Number(item.price))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-white">Observed changes</h3>
              {lineEvents.length === 0 ? (
                <p className="rounded-lg border border-slate-800 p-5 text-sm text-slate-500">
                  No line-item changes observed yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {lineEvents.map((event) => (
                    <div
                      key={event.id}
                      className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-medium text-slate-200">
                          {eventTitle(event)}
                          <span className="ml-2 font-mono text-[10px] text-slate-500">
                            {data.lineItemLabels[event.entityId] || "Line item"}
                          </span>
                        </div>
                        <time className="text-[11px] text-slate-500">
                          {formatObservedAt(event.occurredAt)}
                        </time>
                      </div>
                      {event.eventType === "field_change" && (
                        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                          <div className="rounded bg-red-950/30 p-2 text-red-300">
                            <span className="mr-1 text-[10px] uppercase text-red-400/70">Before</span>
                            {formatValue(event.field, event.oldValue)}
                          </div>
                          <div className="rounded bg-emerald-950/30 p-2 text-emerald-300">
                            <span className="mr-1 text-[10px] uppercase text-emerald-400/70">After</span>
                            {formatValue(event.field, event.newValue)}
                          </div>
                        </div>
                      )}
                      {event.eventType === "created" && (
                        <div className="mt-1 text-xs text-emerald-300">
                          {formatValue(null, event.newValue)}
                        </div>
                      )}
                      {event.eventType === "deleted" && (
                        <div className="mt-1 text-xs text-red-300">
                          {formatValue(null, event.oldValue)}
                        </div>
                      )}
                      {event.eventType === "status_change" && (
                        <div className="mt-1 text-xs text-slate-400">
                          {formatValue(event.field, event.oldValue)} →{" "}
                          {formatValue(event.field, event.newValue)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {data.pagination.events.hasMore && (
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() =>
                    void loadPage(
                      {
                        beforeSnapshotId: data.pagination.snapshots.nextBeforeId,
                        beforeEventId: data.pagination.events.nextBeforeId,
                      },
                      true,
                    )
                  }
                  className="mt-3 inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50"
                >
                  {loadingMore && <Loader2 className="animate-spin" size={14} />}
                  {loadingMore ? "Loading older changes…" : "Load older changes"}
                </button>
              )}
            </section>
          </div>
        )}

        {!orderId && (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <X size={16} /> Select an order to view line-item history.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}