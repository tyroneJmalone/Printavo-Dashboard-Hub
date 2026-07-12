import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListPrintavoStatuses,
  getListPrintavoStatusesQueryKey,
  useListPrintQueueOrders,
  getListPrintQueueOrdersQueryKey,
  getGetCombinedWorkordersHtmlUrl,
  type PrintQueueOrder,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  Printer,
  FileText,
  Package,
  Loader2,
  ChevronDown,
  ExternalLink,
  X,
  RefreshCw,
} from "lucide-react";

const STATUS_STORAGE_KEY = "printQueue.statusIds";
const MAX_PRINT_BATCH = 50;

function loadSavedStatusIds(): string[] {
  try {
    const raw = localStorage.getItem(STATUS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtMoney(total: string | null): string {
  if (total == null) return "—";
  const n = Number(total);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function printavoDocUrl(printavoId: string, doc: "packing_slip" | "box_labels"): string {
  return `https://www.printavo.com/invoices/${printavoId}/${doc}`;
}

/* ── Status multi-select ─────────────────────────────────────────────── */

function StatusPicker({
  statuses,
  selected,
  onChange,
}: {
  statuses: { id: string; name: string; color?: string | null }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 rounded-md bg-[#0f172a] border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 transition-colors"
        data-testid="button-status-picker"
      >
        <span>
          {selected.length === 0
            ? "Select statuses…"
            : `${selected.length} status${selected.length === 1 ? "" : "es"} selected`}
        </span>
        <ChevronDown size={14} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-80 max-h-80 overflow-y-auto rounded-md bg-[#0f172a] border border-slate-700 shadow-xl custom-scrollbar">
          {statuses.map((s) => (
            <label
              key={s.id}
              className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-slate-200 hover:bg-slate-800 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(s.id)}
                onChange={() => toggle(s.id)}
                className="accent-[#059669]"
                data-testid={`checkbox-status-${s.id}`}
              />
              <span
                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: s.color || "#475569" }}
              />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Packing slip / box label launcher ───────────────────────────────── */

function DocLinksDialog({
  title,
  doc,
  orders,
  skippedQuotes,
  onClose,
}: {
  title: string;
  doc: "packing_slip" | "box_labels";
  orders: PrintQueueOrder[];
  skippedQuotes: number;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[80vh] flex flex-col rounded-lg bg-[#0f172a] border border-slate-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" data-testid="button-close-doc-dialog">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-3 text-[12px] text-slate-400 border-b border-slate-800">
          These Printavo pages need your logged-in browser session, so they open as
          separate tabs — click each link below.
          {skippedQuotes > 0 && (
            <span className="text-amber-400">
              {" "}
              {skippedQuotes} quote{skippedQuotes === 1 ? "" : "s"} skipped (invoices only).
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-2">
          {orders.length === 0 ? (
            <div className="px-2 py-6 text-center text-[13px] text-slate-500">
              No invoices in the selection.
            </div>
          ) : (
            orders.map((o) => (
              <a
                key={o.printavoId}
                href={printavoDocUrl(o.printavoId, doc)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-2 py-2 rounded-md text-[13px] text-slate-200 hover:bg-slate-800 transition-colors"
                data-testid={`link-doc-${o.visualId}`}
              >
                <ExternalLink size={13} className="text-[#10b981] flex-shrink-0" />
                <span className="font-semibold">#{o.visualId}</span>
                <span className="truncate text-slate-400">{o.nickname ?? ""}</span>
              </a>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

export default function PrintQueue() {
  const { toast } = useToast();
  const [statusIds, setStatusIds] = useState<string[]>(loadSavedStatusIds);
  const [dateFilter, setDateFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [docDialog, setDocDialog] = useState<"packing_slip" | "box_labels" | null>(null);

  useEffect(() => {
    localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(statusIds));
  }, [statusIds]);

  const { data: statusData } = useListPrintavoStatuses({
    query: { queryKey: getListPrintavoStatusesQueryKey(), staleTime: 5 * 60_000 },
  });
  const statuses = statusData?.statuses ?? [];
  const statusColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statuses) if (s.color) m.set(s.id, s.color);
    return m;
  }, [statuses]);

  const params = { statusIds: statusIds.join(",") };
  const {
    data: orderData,
    isFetching,
    refetch,
  } = useListPrintQueueOrders(params, {
    query: {
      queryKey: getListPrintQueueOrdersQueryKey(params),
      enabled: statusIds.length > 0,
    },
  });
  const orders = useMemo(
    () => (statusIds.length > 0 ? (orderData?.orders ?? []) : []),
    [orderData, statusIds.length],
  );

  const filtered = useMemo(() => {
    const f = dateFilter.trim().toLowerCase();
    if (!f) return orders;
    return orders.filter((o) => fmtDate(o.productionDueAt).toLowerCase().includes(f));
  }, [orders, dateFilter]);

  // Drop selections that fell out of the current result set.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(orders.map((o) => o.printavoId));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [orders]);

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((o) => selected.has(o.printavoId));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((o) => next.delete(o.printavoId));
      else filtered.forEach((o) => next.add(o.printavoId));
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedOrders = useMemo(
    () => orders.filter((o) => selected.has(o.printavoId)),
    [orders, selected],
  );
  const selectedInvoices = useMemo(
    () => selectedOrders.filter((o) => o.orderType === "invoice"),
    [selectedOrders],
  );

  const printWorkorders = () => {
    const withWo = selectedOrders.filter((o) => o.hasWorkorder);
    const skipped = selectedOrders.length - withWo.length;
    if (withWo.length === 0) {
      toast({
        title: "Nothing to print",
        description: "None of the selected orders have a workorder page.",
        variant: "destructive",
      });
      return;
    }
    if (withWo.length > MAX_PRINT_BATCH) {
      toast({
        title: "Too many orders",
        description: `Print at most ${MAX_PRINT_BATCH} workorders per batch.`,
        variant: "destructive",
      });
      return;
    }
    const url = getGetCombinedWorkordersHtmlUrl({
      ids: withWo.map((o) => o.printavoId).join(","),
    });
    // Synchronous window.open on click — popup-blocker-safe.
    window.open(url, "_blank");
    if (skipped > 0) {
      toast({
        title: `${skipped} order${skipped === 1 ? "" : "s"} skipped`,
        description: "They have no workorder page in Printavo.",
      });
    }
  };

  return (
    <AppShell>
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-lg font-semibold text-white flex items-center gap-2">
              <Printer size={18} className="text-[#10b981]" /> Print Queue
            </h1>
            <p className="text-[12px] text-slate-400 mt-0.5">
              Pick statuses, select orders, then print workorders or open packing
              slips &amp; box labels.
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <StatusPicker statuses={statuses} selected={statusIds} onChange={setStatusIds} />
          <input
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            placeholder="Filter by production date…"
            className="px-3 py-2 rounded-md bg-[#0f172a] border border-slate-700 text-[13px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-[#059669] w-56"
            data-testid="input-date-filter"
          />
          <button
            onClick={() => refetch()}
            disabled={statusIds.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-refresh"
          >
            {isFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh
          </button>
          <div className="flex-1" />
          <button
            onClick={printWorkorders}
            disabled={selected.size === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#059669] text-white text-[13px] font-semibold hover:bg-[#047857] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-print-workorders"
          >
            <Printer size={14} /> Print Workorders ({selected.size})
          </button>
          <button
            onClick={() => setDocDialog("packing_slip")}
            disabled={selected.size === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-packing-slips"
          >
            <FileText size={14} /> Packing Slips
          </button>
          <button
            onClick={() => setDocDialog("box_labels")}
            disabled={selected.size === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-box-labels"
          >
            <Package size={14} /> Box Labels
          </button>
        </div>

        {/* Table */}
        <div className="rounded-lg bg-[#0f172a] border border-slate-800 overflow-hidden">
          {statusIds.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-slate-500">
              Select one or more Printavo statuses to load orders.
            </div>
          ) : isFetching && !orderData ? (
            <div className="py-16 flex items-center justify-center gap-2 text-[13px] text-slate-400">
              <Loader2 size={15} className="animate-spin" /> Loading orders…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-slate-500">
              No orders in the selected statuses
              {dateFilter.trim() ? " matching that date filter" : ""}.
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAll}
                      className="accent-[#059669]"
                      data-testid="checkbox-select-all"
                    />
                  </th>
                  <th className="px-3 py-2.5">Order</th>
                  <th className="px-3 py-2.5">Nickname</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5 text-right">Qty</th>
                  <th className="px-3 py-2.5 text-right">Total</th>
                  <th className="px-3 py-2.5">Production due</th>
                  <th className="px-3 py-2.5">Customer due</th>
                  <th className="px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr
                    key={o.printavoId}
                    className={`border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40 cursor-pointer transition-colors ${
                      selected.has(o.printavoId) ? "bg-[#059669]/5" : ""
                    }`}
                    onClick={() => toggleOne(o.printavoId)}
                    data-testid={`row-order-${o.visualId}`}
                  >
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(o.printavoId)}
                        onChange={() => toggleOne(o.printavoId)}
                        className="accent-[#059669]"
                        data-testid={`checkbox-order-${o.visualId}`}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-white">#{o.visualId}</span>
                      {o.orderType === "quote" && (
                        <span className="ml-1.5 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                          Quote
                        </span>
                      )}
                      {!o.hasWorkorder && (
                        <span className="ml-1.5 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
                          No WO
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-300 max-w-[240px] truncate">
                      {o.nickname ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-slate-300 max-w-[200px] truncate">
                      {o.customerCompany ?? o.contactName ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {o.quantity ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {fmtMoney(o.total)}
                    </td>
                    <td className="px-3 py-2.5 text-slate-300">{fmtDate(o.productionDueAt)}</td>
                    <td className="px-3 py-2.5 text-slate-300">{fmtDate(o.customerDueAt)}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor:
                              (o.statusId && statusColor.get(o.statusId)) || "#475569",
                          }}
                        />
                        <span className="text-slate-300">{o.statusName ?? "—"}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {statusIds.length > 0 && filtered.length > 0 && (
          <div className="mt-2 text-[12px] text-slate-500">
            {filtered.length} order{filtered.length === 1 ? "" : "s"}
            {dateFilter.trim() ? ` (filtered from ${orders.length})` : ""} · {selected.size}{" "}
            selected
          </div>
        )}
      </div>

      {docDialog && (
        <DocLinksDialog
          title={docDialog === "packing_slip" ? "Packing Slips" : "Box Labels"}
          doc={docDialog}
          orders={selectedInvoices}
          skippedQuotes={selectedOrders.length - selectedInvoices.length}
          onClose={() => setDocDialog(null)}
        />
      )}
    </AppShell>
  );
}
