import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListPoFiles,
  useUpdatePoFile,
  getListPoFilesQueryKey,
  getGetPoFileHtmlUrl,
  type PoFile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/format";
import {
  ClipboardList,
  Loader2,
  RefreshCw,
  Printer,
  ChevronDown,
  ChevronRight,
  Pencil,
  Check,
  X,
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
  const [poNumber, setPoNumber] = useState(po.poNumber);
  const [notes, setNotes] = useState(po.notes ?? "");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdatePoFile({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPoFilesQueryKey() });
        setEditing(false);
        toast({ title: "PO updated" });
      },
      onError: () =>
        toast({ title: "Update failed", variant: "destructive" }),
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
          {editing ? (
            <input
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm font-mono text-white w-36"
            />
          ) : (
            <div className="font-mono font-bold text-white">{po.poNumber}</div>
          )}
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
            po.pushedToPrintavoAt
              ? "bg-[#059669]/10 text-[#10b981] border border-[#059669]/20"
              : "bg-slate-800/70 text-slate-500 border border-slate-700"
          }`}
        >
          {po.pushedToPrintavoAt ? "Pushed to Printavo" : "Not pushed"}
        </span>
        <div className="flex-1" />
        {editing ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                update.mutate({ id: po.id, data: { poNumber, notes: notes || null } })
              }
              disabled={update.isPending || poNumber.trim().length === 0}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#059669] text-white hover:bg-[#047857] transition-colors disabled:opacity-50"
            >
              {update.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setPoNumber(po.poNumber);
                setNotes(po.notes ?? "");
              }}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <X size={13} /> Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <Pencil size={13} /> Edit
            </button>
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

      {editing && (
        <div className="px-5 pb-4">
          <label className="text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="mt-1 w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200"
          />
        </div>
      )}

      {open && (
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
