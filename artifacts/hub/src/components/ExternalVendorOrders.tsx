import { useState } from "react";
import {
  useListExternalVendorOrders,
  getListExternalVendorOrdersQueryKey,
  useImportExternalVendorOrders,
  useRefreshExternalVendorOrder,
  refreshExternalVendorOrder,
  type ExternalVendorImportResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Download, ExternalLink, Loader2, RefreshCw, AlertTriangle } from "lucide-react";

const VENDOR_LABELS: Record<string, string> = { sanmar: "SanMar", ss: "S&S" };

function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

function trackingUrl(carrier: string | null, n: string): string {
  const c = (carrier ?? "").toLowerCase();
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`;
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`;
  return `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function dateBasisLabel(vendor: string, basis: string): string {
  const b = basis.toLowerCase();
  if (b.includes("place")) return "Placed";
  if (b.includes("status") || b.includes("update")) return "Status updated";
  return vendor === "sanmar" ? "Status updated" : basis;
}

export function ExternalVendorOrders() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const [importResult, setImportResult] = useState<ExternalVendorImportResult | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [bulkOutcomes, setBulkOutcomes] = useState<string[]>([]);

  const { data, isLoading, isError, error, refetch, isFetching } = useListExternalVendorOrders({
    query: { queryKey: getListExternalVendorOrdersQueryKey(), staleTime: 30_000, refetchOnWindowFocus: true },
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListExternalVendorOrdersQueryKey() });

  const importOrders = useImportExternalVendorOrders({
    mutation: {
      onSuccess: (r) => {
        setImportResult(r);
        invalidate();
        toast({
          title: r.errors.length ? "Import finished with errors" : "Import finished",
          description: `${r.imported} new · ${r.updated} updated · ${r.skippedHub} already in Hub`,
          variant: r.errors.length ? "destructive" : undefined,
        });
      },
      onError: (err) => toast({ title: "Import failed", description: apiError(err) ?? "Request failed", variant: "destructive" }),
    },
  });

  const refreshOne = useRefreshExternalVendorOrder({
    mutation: {
      onSuccess: (o) => { invalidate(); toast({ title: "Vendor status checked", description: `PO ${o.poNumber}${o.vendorStatus ? ` · ${o.vendorStatus}` : ""}` }); },
      onError: (err) => toast({ title: "Vendor check failed", description: apiError(err) ?? "Request failed", variant: "destructive" }),
    },
  });

  const orders = data ?? [];
  const active = orders.filter((o) => !o.terminal);

  const refreshAll = async () => {
    if (!active.length || bulk) return;
    const out: string[] = [];
    setBulkOutcomes([]);
    setBulk({ done: 0, total: active.length });
    try {
      for (const [i, o] of active.entries()) {
        try {
          const r = await refreshExternalVendorOrder(o.id);
          out.push(`PO ${o.poNumber} · ${r.vendorStatus ?? "no vendor status"}${r.terminal ? " · finished" : ""}`);
        } catch (err) {
          out.push(`PO ${o.poNumber} · failed — ${apiError(err) ?? (err instanceof Error ? err.message : "Request failed")}`);
        }
        setBulkOutcomes([...out]);
        setBulk({ done: i + 1, total: active.length });
      }
      toast({ title: "External checks finished", description: `${active.length} active records checked.` });
    } finally {
      setBulk(null);
      invalidate();
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-slate-800 bg-slate-950/40" data-testid="section-external-orders">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 text-left" data-testid="button-toggle-external">
          {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
          <span className="text-[15px] font-semibold text-slate-100">Placed outside Hub</span>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300">{orders.length}</span>
          <span className="text-[12px] text-slate-500">Read-only vendor records · no Hub purchasing actions</span>
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void refreshAll(); }}
            disabled={!!bulk || active.length === 0 || refreshOne.isPending}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium text-slate-300 border border-slate-700 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="button-refresh-external-active"
          >
            {bulk ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {bulk ? `Checking ${bulk.done}/${bulk.total}` : `Refresh active (${active.length})`}
          </button>
          <button
            type="button"
            onClick={() => importOrders.mutate()}
            disabled={importOrders.isPending || !!bulk}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium bg-[#059669]/10 text-[#10b981] border border-[#059669]/30 hover:bg-[#059669]/20 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="button-import-external"
          >
            {importOrders.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Import last 7 days
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-800 px-4 py-4">
          <div className="mb-4 grid gap-2 text-[12px] text-slate-400 md:grid-cols-2">
            <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
              <div className="font-semibold text-slate-200">S&amp;S · placed date</div>
              Imports orders S&amp;S reports as placed in the last seven days.
            </div>
            <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
              <div className="font-semibold text-slate-200">SanMar · status-updated date</div>
              SanMar only reports when an order's status last changed, so the import covers orders updated in the last seven days. The original order date is not available and is shown as unknown.
            </div>
          </div>
          <p className="mb-4 text-[12px] text-slate-500">POs already submitted through Hub are skipped by the server, so nothing appears twice.</p>

          {importResult && (
            <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-300" role="status" data-testid="status-import-result">
              <div className="font-semibold text-slate-100">
                Import {fmtDate(importResult.since)} – {fmtDate(importResult.through)}
              </div>
              <div className="mt-1">{importResult.imported} new · {importResult.updated} updated · {importResult.skippedHub} skipped (already in Hub)</div>
              {importResult.errors.map((e, i) => (
                <div key={i} className="mt-1 flex items-start gap-1.5 text-amber-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{e}</div>
              ))}
            </div>
          )}
          {bulkOutcomes.length > 0 && (
            <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-300" role="status">
              <div className="font-semibold text-slate-100 mb-1">Refresh outcomes</div>
              {bulkOutcomes.map((l, i) => <div key={i} className="py-0.5">{l}</div>)}
            </div>
          )}

          {isLoading ? (
            <div className="space-y-2" data-testid="loading-external">
              {[0, 1, 2].map((i) => <div key={i} className="h-10 rounded bg-slate-800/50 animate-pulse" />)}
            </div>
          ) : isError ? (
            <div className="rounded border border-red-500/30 bg-red-500/5 p-4 text-[13px] text-red-300">
              Could not load external records: {apiError(error) ?? "Request failed"}
              <button type="button" onClick={() => { void refetch(); }} className="ml-3 underline" data-testid="button-retry-external">Retry</button>
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-10 text-slate-500 text-[14px]">
              No outside orders imported yet. Use Import last 7 days to pull recent SanMar and S&amp;S orders placed outside Hub.
            </div>
          ) : (
            <div className={`rounded-lg border border-slate-800 overflow-x-auto ${isFetching ? "opacity-80" : ""}`}>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-slate-900/80 text-slate-400 text-left text-[11px] uppercase tracking-wider">
                    <th className="px-4 py-2.5 font-semibold">PO #</th>
                    <th className="px-4 py-2.5 font-semibold">Vendor</th>
                    <th className="px-4 py-2.5 font-semibold">Order / confirmation</th>
                    <th className="px-4 py-2.5 font-semibold">Vendor status</th>
                    <th className="px-4 py-2.5 font-semibold">Warehouse</th>
                    <th className="px-4 py-2.5 font-semibold">Delivery (vendor)</th>
                    <th className="px-4 py-2.5 font-semibold">Tracking</th>
                    <th className="px-4 py-2.5 font-semibold">Date</th>
                    <th className="px-4 py-2.5 font-semibold">Last checked</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const busy = refreshOne.isPending && refreshOne.variables?.id === o.id;
                    return (
                      <tr key={o.id} className="border-t border-slate-800/80 bg-[#0b1220]" data-testid={`row-external-order-${o.id}`}>
                        <td className="px-4 py-3 font-semibold text-slate-200">{o.poNumber}</td>
                        <td className="px-4 py-3 text-slate-300">{VENDOR_LABELS[o.vendor] ?? o.vendor}</td>
                        <td className="px-4 py-3 text-slate-400">
                          {o.orderNumbers.length ? o.orderNumbers.join(", ") : "—"}
                          {o.reference && !o.orderNumbers.includes(o.reference) && <div className="text-[11px] text-slate-500">Ref {o.reference}</div>}
                        </td>
                        <td className="px-4 py-3 text-slate-300">
                          {o.vendorStatus ?? "—"}
                          {o.terminal && <span className="ml-1.5 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">final</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-400">{o.warehouse ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-400">{o.deliveryStatus ?? "—"}</td>
                        <td className="px-4 py-3">
                          {o.tracking.length === 0 ? <span className="text-slate-500">—</span> : (
                            <div className="flex flex-col gap-1">
                              {o.tracking.map((t) => (
                                <a key={t.trackingNumber} href={trackingUrl(t.carrier, t.trackingNumber)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#10b981] hover:underline" data-testid={`link-external-tracking-${t.trackingNumber}`}>
                                  {t.trackingNumber}<ExternalLink className="w-3 h-3" />
                                  {t.carrier && <span className="text-slate-500 text-[11px]">{t.carrier}</span>}
                                </a>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">{dateBasisLabel(o.vendor, o.dateBasis)}</div>
                          <div className="text-slate-400">{fmtDate(o.orderDate)}</div>
                          {o.vendor === "sanmar" && <div className="text-[11px] text-slate-500">Order date unknown</div>}
                        </td>
                        <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{fmtDate(o.checkedAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => refreshOne.mutate({ id: o.id })}
                            disabled={refreshOne.isPending || !!bulk}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] font-medium text-slate-300 border border-slate-700 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                            data-testid={`button-refresh-external-${o.id}`}
                          >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                            Check vendor
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
