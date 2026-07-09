import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListPoFiles,
  useUnlockPoFile,
  getListPoFilesQueryKey,
  getGetPoFileHtmlUrl,
  type PoFile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { PoEditor } from "@/components/purchasing/PoEditor";
import { formatNumber } from "@/lib/format";
import {
  ClipboardList,
  Loader2,
  RefreshCw,
  Printer,
  ChevronDown,
  ChevronRight,
  Pencil,
  Lock,
  Unlock,
} from "lucide-react";

const VENDOR_LABELS: Record<string, string> = {
  sanmar: "SanMar",
  ss: "S&S Activewear",
  manual: "Manual",
};

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function PoRow({ po }: { po: PoFile }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const unlock = useUnlockPoFile({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPoFilesQueryKey() });
        toast({
          title: `PO ${po.poNumber} unlocked`,
          description:
            "It was already pushed to Printavo — re-push after your changes so Printavo matches.",
        });
      },
      onError: (err) => {
        const apiMsg =
          err && typeof err === "object" && "data" in err
            ? (err as { data?: { error?: string } }).data?.error
            : undefined;
        toast({
          title: "Could not unlock PO",
          description: apiMsg ?? "Unlock failed",
          variant: "destructive",
        });
      },
    },
  });

  const created = new Date(po.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 flex flex-wrap items-center gap-4">
        <button
          onClick={() => setOpen(!open)}
          className="text-slate-400 hover:text-white transition-colors"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-[140px]">
          <div className="font-mono font-bold text-white">{po.poNumber}</div>
          <div className="text-[11px] text-slate-500">{created}</div>
        </div>
        <span className="inline-flex items-center px-2 py-1 rounded text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
          {VENDOR_LABELS[po.vendorName] ?? po.vendorName}
        </span>
        <div className="text-xs text-slate-400">
          {po.lineItems.length} line{po.lineItems.length === 1 ? "" : "s"} ·{" "}
          {formatNumber(po.totalQuantity)} pcs
        </div>
        <div className="font-mono font-bold text-[#10b981]">{money(po.totalCost)}</div>
        <span
          className={`inline-flex items-center px-2 py-1 rounded text-[11px] font-semibold ${
            po.submittedToVendorAt
              ? "bg-sky-500/10 text-sky-400 border border-sky-500/20"
              : po.pushedToPrintavoAt
                ? "bg-[#059669]/10 text-[#10b981] border border-[#059669]/20"
                : "bg-slate-800/70 text-slate-500 border border-slate-700"
          }`}
        >
          {po.submittedToVendorAt
            ? "Submitted to vendor"
            : po.pushedToPrintavoAt
              ? "Pushed to Printavo"
              : "Not pushed"}
        </span>
        {po.locked && (
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20"
            title={
              po.lockReason === "vendor"
                ? "Submitted to the vendor — permanently locked"
                : "Pushed to Printavo — unlock to edit"
            }
          >
            <Lock size={11} /> Locked
          </span>
        )}
        <div className="flex-1" />
        {!editing && (
          <div className="flex items-center gap-2">
            {!po.locked && (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
              >
                <Pencil size={13} /> Edit
              </button>
            )}
            {po.locked && po.lockReason === "printavo" && (
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Unlock PO ${po.poNumber}? It was already pushed to Printavo — after editing, re-push it so Printavo matches.`,
                    )
                  ) {
                    unlock.mutate({ id: po.id });
                  }
                }}
                disabled={unlock.isPending}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
              >
                {unlock.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Unlock size={13} />
                )}
                Unlock
              </button>
            )}
            <a
              href={getGetPoFileHtmlUrl(po.id)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors"
            >
              <Printer size={13} /> View / Print
            </a>
          </div>
        )}
      </div>

      {editing && <PoEditor po={po} onClose={() => setEditing(false)} />}

      {open && !editing && (
        <div className="border-t border-slate-800">
          {po.notes && !editing && (
            <div className="px-5 py-2 text-xs text-slate-400 bg-slate-900/60 border-b border-slate-800 whitespace-pre-wrap">
              {po.notes}
            </div>
          )}
          <table className="w-full text-sm text-left">
            <thead className="text-[11px] text-slate-400 bg-slate-900/80 uppercase tracking-wider">
              <tr>
                <th className="px-5 py-2 font-semibold">Style</th>
                <th className="px-5 py-2 font-semibold">Color</th>
                <th className="px-5 py-2 font-semibold">Sizes</th>
                <th className="px-5 py-2 font-semibold">Ship From</th>
                <th className="px-5 py-2 font-semibold text-center">Order</th>
                <th className="px-5 py-2 font-semibold text-right">Qty</th>
                <th className="px-5 py-2 font-semibold text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {po.lineItems.map((li, idx) => {
                const qty = li.sizes.reduce((a, s) => a + s.qty, 0);
                const cost = li.sizes.reduce((a, s) => a + s.qty * s.unitCost, 0);
                return (
                  <tr key={idx}>
                    <td className="px-5 py-2.5">
                      <div className="font-mono font-semibold text-slate-200">{li.styleNumber}</div>
                      <div className="text-[11px] text-slate-500">{li.brand ?? ""}</div>
                    </td>
                    <td className="px-5 py-2.5 text-slate-300">
                      {li.vendorCatalogColor ?? li.color ?? "—"}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {li.sizes
                          .filter((s) => s.qty > 0)
                          .map((s, i) => (
                            <span key={i} className="text-[10px] font-mono bg-slate-800 border border-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                              {s.size}×{s.qty}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-slate-400 text-xs">
                      {li.warehouseName ?? li.warehouseCode ?? "—"}
                    </td>
                    <td className="px-5 py-2.5 text-center font-mono text-slate-400">
                      {li.visualId ? `#${li.visualId}` : "—"}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-slate-200">{qty}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-[#10b981]">{money(cost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PoLog() {
  const { data, isLoading, isFetching, refetch } = useListPoFiles();

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <ClipboardList className="text-[#10b981]" size={24} />
                PO Log
              </h1>
              <p className="text-xs text-slate-400 mt-1">Purchase orders built from the Vendor Orders cart</p>
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
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="animate-spin text-[#10b981]" size={32} />
            </div>
          ) : !data || data.poFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-500">
              <ClipboardList size={40} className="mb-3 opacity-50" />
              <div className="text-sm font-medium">No purchase orders yet</div>
              <div className="text-xs mt-1">Build one from the Vendor Orders cart.</div>
            </div>
          ) : (
            data.poFiles.map((po) => <PoRow key={po.id} po={po} />)
          )}
        </div>
      </div>
    </AppShell>
  );
}
