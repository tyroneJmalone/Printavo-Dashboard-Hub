import { AppShell } from "@/components/layout/AppShell";
import { useGetNeedsOrdering } from "@workspace/api-client-react";
import { formatNumber, formatDate } from "@/lib/format";
import { Truck, Loader2, RefreshCw, PackageSearch, Layers, Boxes, CalendarClock } from "lucide-react";

function statusPill(name: string | null): string {
  if (!name) return "Unknown";
  const idx = name.indexOf(" - ");
  return idx >= 0 ? name.slice(idx + 3).trim() : name;
}

export default function VendorOrders() {
  const { data, isLoading, isFetching, refetch } = useGetNeedsOrdering();

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <Truck className="text-[#10b981]" size={24} />
                Vendor Orders
              </h1>
              <p className="text-xs text-slate-400 mt-1">Line items flagged "needs ordering" in Printavo, refreshed by the 5-minute sync</p>
            </div>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {!isLoading && data && (
            <div className="grid grid-cols-3 gap-4 mt-5">
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><PackageSearch size={13} /> Orders Needing Purchase</div>
                <div className="text-2xl font-bold text-white">{formatNumber(data.totalOrders)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><Layers size={13} /> Line Items</div>
                <div className="text-2xl font-bold text-white">{formatNumber(data.totalLineItems)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><Boxes size={13} /> Total Pieces</div>
                <div className="text-2xl font-bold text-[#10b981]">{formatNumber(data.totalPieces)}</div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="animate-spin text-[#10b981]" size={32} />
            </div>
          ) : !data || data.orders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-500">
              <PackageSearch size={40} className="mb-3 opacity-50" />
              <div className="text-sm font-medium">Nothing needs ordering right now</div>
              <div className="text-xs mt-1">Line items marked "needs ordering" in Printavo will appear here within ~5 minutes.</div>
            </div>
          ) : (
            data.orders.map((order) => (
              <div key={order.orderId} className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-900/60">
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="text-base font-bold text-white">#{order.visualId}</div>
                      <div className="text-xs text-slate-500">{order.nickname || "—"}</div>
                    </div>
                    <div className="h-8 w-px bg-slate-800" />
                    <div>
                      <div className="text-sm font-medium text-slate-200">{order.customerCompany || order.contactName || "—"}</div>
                      <div className="text-xs text-slate-500">{order.contactName && order.customerCompany ? order.contactName : ""}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-xs text-slate-400 flex items-center gap-1.5">
                      <CalendarClock size={13} />
                      <span>Prod due {formatDate(order.productionDueAt)}</span>
                    </div>
                    <span className="inline-flex items-center px-2 py-1 rounded text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                      {statusPill(order.statusName)}
                    </span>
                  </div>
                </div>
                <table className="w-full text-sm text-left">
                  <thead className="text-[11px] text-slate-400 bg-slate-900/80 uppercase tracking-wider">
                    <tr>
                      <th className="px-5 py-2.5 font-semibold">Style</th>
                      <th className="px-5 py-2.5 font-semibold">Color</th>
                      <th className="px-5 py-2.5 font-semibold">Description</th>
                      <th className="px-5 py-2.5 font-semibold">Sizes</th>
                      <th className="px-5 py-2.5 font-semibold text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {order.lineItems.map((li) => (
                      <tr key={li.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-5 py-3">
                          <div className="font-mono font-semibold text-slate-200">{li.itemNumber || "—"}</div>
                          <div className="text-[11px] text-slate-500">{li.brand || ""}</div>
                        </td>
                        <td className="px-5 py-3 text-slate-300">{li.color || "—"}</td>
                        <td className="px-5 py-3 text-slate-400 max-w-[280px] truncate">{li.description || "—"}</td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {li.sizes.length === 0 ? (
                              <span className="text-slate-600 text-xs">—</span>
                            ) : (
                              li.sizes.map((s, i) => (
                                <span key={i} className="text-[10px] font-mono bg-slate-800 border border-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                                  {s.size}×{s.count}
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right font-mono font-bold text-[#10b981]">{formatNumber(li.items)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </div>
    </AppShell>
  );
}
