import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListPoFiles,
  useUnlockPoFile,
  usePushPoFile,
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
  Send,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

const VENDOR_LABELS: Record<string, string> = {
  sanmar: "SanMar",
  ss: "S&S Activewear",
  manual: "Manual",
};

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

/** Inline status panel for the latest push cycle (running / failed / success). */
function PushStatusPanel({ po }: { po: PoFile }) {
  const ps = po.pushState;
  if (!ps) return null;

  if (ps.status === "running") {
    const total = ps.lines.filter((l) => l.status !== "no_link").length;
    const finished = ps.lines.filter(
      (l) => l.status === "done" || l.status === "skipped_ordered" || l.status === "failed",
    ).length;
    return (
      <div className="mx-5 mb-3 px-4 py-2.5 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center gap-2 text-xs text-sky-300">
        <Loader2 size={13} className="animate-spin flex-shrink-0" />
        Pushing to Printavo… {finished} of {total} line{total === 1 ? "" : "s"} processed
      </div>
    );
  }

  if (ps.status === "failed") {
    const failedLines = ps.lines.filter((l) => l.status === "failed");
    return (
      <div className="mx-5 mb-3 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/25 text-xs space-y-1.5">
        <div className="flex items-center gap-2 text-red-400 font-semibold">
          <AlertTriangle size={13} className="flex-shrink-0" />
          Push failed — retry will resume where it left off
        </div>
        {ps.error && <div className="text-red-300/90">{ps.error}</div>}
        {failedLines.map((l) => (
          <div key={l.key} className="text-red-300/90">
            <span className="font-mono font-semibold">{l.styleNumber}</span>
            {l.color ? ` ${l.color}` : ""}
            {l.visualId ? ` (order #${l.visualId})` : ""}: {l.detail ?? "failed"}
          </div>
        ))}
      </div>
    );
  }

  const done = ps.lines.filter((l) => l.status === "done").length;
  const skipped = ps.lines.filter((l) => l.status === "skipped_ordered").length;
  return (
    <div className="mx-5 mb-3 px-4 py-2.5 rounded-lg bg-[#059669]/10 border border-[#059669]/20 flex items-center gap-2 text-xs text-[#10b981]">
      <CheckCircle2 size={13} className="flex-shrink-0" />
      Pushed{ps.finishedAt ? ` ${new Date(ps.finishedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
      : {done} line{done === 1 ? "" : "s"} marked ordered
      {skipped > 0 ? `, ${skipped} already ordered` : ""}
      {ps.attachedInvoiceIds.length > 0
        ? `, PO attached to ${ps.attachedInvoiceIds.length} invoice${ps.attachedInvoiceIds.length === 1 ? "" : "s"}`
        : ""}
    </div>
  );
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
        toast({
          title: "Could not unlock PO",
          description: apiError(err) ?? "Unlock failed",
          variant: "destructive",
        });
      },
    },
  });

  const push = usePushPoFile({
    mutation: {
      onSuccess: () => {
        // Push runs in the background — polling picks up progress via pushState.
        queryClient.invalidateQueries({ queryKey: getListPoFilesQueryKey() });
      },
      onError: (err) => {
        toast({
          title: "Could not start push",
          description: apiError(err) ?? "Push failed to start",
          variant: "destructive",
        });
      },
    },
  });

  const pushing = po.pushState?.status === "running";
  const linkedLines = po.lineItems.filter((li) => li.printavoLineItemId).length;
  const linkedInvoices = new Set(
    po.lineItems.map((li) => li.printavoOrderId).filter(Boolean),
  ).size;
  const canPush = !po.submittedToVendorAt && linkedLines > 0;
  const pushLabel =
    po.pushState?.status === "failed"
      ? "Retry push"
      : po.pushedToPrintavoAt
        ? "Re-push"
        : "Push to Printavo";

  const confirmPush = () => {
    if (
      window.confirm(
        `Push PO ${po.poNumber} to Printavo?\n\nThis will mark ${linkedLines} linked line${linkedLines === 1 ? "" : "s"} as Ordered and attach the PO document to ${linkedInvoices} invoice${linkedInvoices === 1 ? "" : "s"}. Lines already marked ordered in Printavo are left untouched.`,
      )
    ) {
      push.mutate({ id: po.id });
    }
  };

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
            {canPush && (
              <button
                onClick={confirmPush}
                disabled={pushing || push.isPending}
                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                  po.pushState?.status === "failed"
                    ? "bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                    : "bg-[#059669]/10 border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20"
                }`}
              >
                {pushing || push.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
                {pushing ? "Pushing…" : pushLabel}
              </button>
            )}
            {!po.locked && !pushing && (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
              >
                <Pencil size={13} /> Edit
              </button>
            )}
            {po.locked && po.lockReason === "printavo" && !pushing && (
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

      {!editing && <PushStatusPanel po={po} />}

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
  const { data, isLoading, isFetching, refetch } = useListPoFiles({
    query: {
      queryKey: getListPoFilesQueryKey(),
      // Poll while any PO's push is running so progress/result appear live.
      refetchInterval: (query) =>
        query.state.data?.poFiles.some((p) => p.pushState?.status === "running")
          ? 2000
          : false,
    },
  });

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
