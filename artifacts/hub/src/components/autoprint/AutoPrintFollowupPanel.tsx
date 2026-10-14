import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAutoPrintFollowup,
  getGetAutoPrintFollowupQueryKey,
  usePreviewAutoPrintFollowup,
  useConfirmAutoPrintFollowup,
  type AutoPrintFollowupInvoice,
  type AutoPrintFollowupPreview,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { AlertTriangle, ChevronDown, Loader2, ShieldCheck } from "lucide-react";

const MAX_SELECT = 20;

const STATE_STYLES: Record<string, string> = {
  candidate: "bg-slate-500/15 text-slate-300",
  ready: "bg-emerald-500/15 text-emerald-300",
  blocked: "bg-red-500/15 text-red-300",
  noop: "bg-slate-500/15 text-slate-400",
  updated: "bg-emerald-500/15 text-emerald-300",
  status_queued: "bg-sky-500/15 text-sky-300",
  review_required: "bg-amber-500/15 text-amber-300",
  preview: "bg-slate-500/15 text-slate-300",
  applying: "bg-sky-500/15 text-sky-300",
  complete: "bg-emerald-500/15 text-emerald-300",
};

const STATE_LABELS: Record<string, string> = {
  noop: "no change",
  status_queued: "status queued",
  review_required: "review required",
};

function errInfo(err: unknown): { status?: number; message?: string } {
  if (!err || typeof err !== "object") return {};
  const e = err as { status?: number; data?: { error?: string }; message?: string };
  return { status: e.status, message: e.data?.error ?? e.message };
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StateBadge({ state }: { state: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${STATE_STYLES[state] ?? "bg-slate-500/15 text-slate-300"}`} data-testid={`status-followup-${state}`}>
      {STATE_LABELS[state] ?? state}
    </span>
  );
}

function InvoiceRow({ inv, selectable, checked, onToggle, disabled }: {
  inv: AutoPrintFollowupInvoice;
  selectable?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}) {
  return (
    <li className="rounded-md border border-slate-800 bg-[#020617] px-2.5 py-2" data-testid={`row-followup-${inv.jobId}`}>
      <div className="flex items-start gap-2">
        {selectable && (
          <input type="checkbox" checked={!!checked} disabled={disabled} onChange={onToggle}
            aria-label={`Select invoice ${inv.visualId}`} className="mt-0.5 accent-[#059669]"
            data-testid={`checkbox-followup-${inv.jobId}`} />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-slate-100">#{inv.visualId}</span>
            <span className="truncate text-slate-300">{inv.nickname}</span>
            <span className="ml-auto"><StateBadge state={inv.state} /></span>
          </div>
          <div className="mt-1 text-slate-400">
            {inv.state === "candidate" ? "Status at printing: " : "Status: "}<span className="text-slate-200">{inv.currentStatus || "unknown"}</span>
            {inv.targetStatus && inv.targetStatus !== inv.currentStatus
              ? <> to <span className="text-emerald-300">{inv.targetStatus}</span></>
              : <span className="text-slate-500">{inv.state === "candidate" ? " (preview reads current status)" : " (unchanged)"}</span>}
          </div>
          <div className="mt-0.5 text-slate-400">
            Category changes: {inv.categories.length === 0
              ? <span className="text-slate-500">{inv.state === "candidate" ? "determined by preview" : "none proposed"}</span>
              : inv.categories.map((c, i) => <span key={i} className="mr-1 inline-block rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-200">{c}</span>)}
          </div>
          {inv.message && <div className={`mt-0.5 ${inv.eligible ? "text-slate-500" : "text-amber-300"}`}>{inv.message}</div>}
          {inv.statusJobId && <div className="mt-0.5 text-[11px] text-slate-500 font-mono">Status job {inv.statusJobId}</div>}
        </div>
      </div>
    </li>
  );
}

function FollowupBody({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const queryKey = getGetAutoPrintFollowupQueryKey(runId);
  const list = useGetAutoPrintFollowup(runId, { query: { queryKey, enabled: !!runId, refetchInterval: 10000 } });
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<AutoPrintFollowupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoPrintFollowupPreview | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey });

  const previewMut = usePreviewAutoPrintFollowup();
  const confirmMut = useConfirmAutoPrintFollowup();

  const candidates = (list.data?.invoices ?? []).filter((i) => i.state === "candidate");
  const history = list.data?.history ?? [];
  const readyCount = preview?.invoices.filter((i) => i.eligible && i.state === "ready").length ?? 0;
  const busy = previewMut.isPending || confirmMut.isPending;

  const toggle = (id: string) =>
    setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_SELECT ? cur : [...cur, id]);

  const runPreview = () => {
    setError(null); setResult(null); setPreview(null);
    previewMut.mutate({ runId, data: { jobIds: selected } }, {
      onSuccess: (p) => setPreview(p),
      onError: (e) => setError(errInfo(e).message ?? "Preview failed"),
      onSettled: invalidate,
    });
  };

  const runConfirm = () => {
    if (!preview) return;
    setError(null);
    confirmMut.mutate({ previewId: preview.previewId }, {
      onSuccess: (r) => { setResult(r); setPreview(null); setSelected([]); },
      onError: (e) => {
        const { status, message } = errInfo(e);
        setPreview(null);
        if (status === 409) {
          setPreview(null);
          setError(`This preview is stale, already used, or needs review (${message ?? "conflict"}). Check the correction history before doing anything else; an earlier request may already have applied changes.`);
        } else {
          setError(`Confirm outcome unknown: ${message ?? "request failed"}. Do not retry blindly; check the history below after it refreshes.`);
        }
      },
      onSettled: invalidate,
    });
  };

  if (list.isLoading) return <div className="space-y-1.5" role="status"><div className="h-10 rounded bg-slate-800/60 animate-pulse" /><div className="h-10 rounded bg-slate-800/40 animate-pulse" /></div>;
  if (list.isError) return <p role="alert" className="text-red-300">Could not load follow-up candidates. {errInfo(list.error).message} <button type="button" onClick={() => list.refetch()} className="underline" data-testid="button-followup-retry">Retry</button></p>;

  return (
    <div className="space-y-3">
      <p className="text-slate-400">Corrects Printavo status and line categories for accepted, printed MERCH invoices using the current saved routing rules. Nothing is printed. Existing line categories are preserved.</p>

      {error && <div role="alert" className="flex gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-red-200" data-testid="text-followup-error"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</div>}

      {result && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5" data-testid="panel-followup-result">
          <div className="flex items-center gap-2 text-emerald-300"><ShieldCheck size={14} /> Correction submitted <StateBadge state={result.state} /></div>
          <ul className="mt-2 space-y-1.5">{result.invoices.map((i) => <InvoiceRow key={i.jobId} inv={i} />)}</ul>
        </div>
      )}

      {!preview && (
        candidates.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700 px-3 py-3 text-slate-500" data-testid="text-followup-empty">No accepted printed MERCH invoices in this run are available for correction.</p>
        ) : (
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-slate-400">
              <span>{selected.length} of {candidates.length} selected (max {MAX_SELECT})</span>
              <button type="button" onClick={() => setSelected(candidates.slice(0, MAX_SELECT).map((c) => c.jobId))} className="ml-auto text-sky-300 underline" data-testid="button-followup-select-all">Select first {Math.min(MAX_SELECT, candidates.length)}</button>
              {selected.length > 0 && <button type="button" onClick={() => setSelected([])} className="text-slate-400 underline" data-testid="button-followup-clear">Clear</button>}
            </div>
            <ul className="space-y-1.5 max-h-80 overflow-y-auto custom-scrollbar">
              {candidates.map((c) => (
                <InvoiceRow key={c.jobId} inv={c} selectable checked={selected.includes(c.jobId)} onToggle={() => toggle(c.jobId)}
                  disabled={busy || (!selected.includes(c.jobId) && selected.length >= MAX_SELECT)} />
              ))}
            </ul>
            <button type="button" disabled={selected.length === 0 || busy} onClick={runPreview}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-slate-100 disabled:opacity-40" data-testid="button-followup-preview">
              {previewMut.isPending && <Loader2 size={13} className="animate-spin" />} Preview correction
            </button>
          </div>
        )
      )}

      {preview && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5" data-testid="panel-followup-preview">
          <div className="flex flex-wrap items-center gap-2 text-slate-300">
            <span className="font-semibold">Preview</span><StateBadge state={preview.state} />
            <span className="text-slate-500">by {preview.actor}, expires {fmt(preview.expiresAt)}</span>
          </div>
          <ul className="mt-2 space-y-1.5">{preview.invoices.map((i) => <InvoiceRow key={i.jobId} inv={i} />)}</ul>
          <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-amber-200" data-testid="text-followup-statement">
            No printing will happen. Printavo line categories and status will change for {readyCount} ready invoice{readyCount === 1 ? "" : "s"}. Blocked and no-change rows are left untouched.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={readyCount === 0 || busy} onClick={runConfirm}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#059669]/40 bg-[#059669]/15 px-3 py-1.5 text-[#10b981] disabled:opacity-40" data-testid="button-followup-confirm">
              {confirmMut.isPending && <Loader2 size={13} className="animate-spin" />} Confirm changes in Printavo
            </button>
            <button type="button" disabled={busy} onClick={() => setPreview(null)} className="rounded-lg px-3 py-1.5 text-slate-400 hover:text-slate-200" data-testid="button-followup-cancel">Cancel</button>
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">Correction history</div>
        {history.length === 0 ? <p className="text-slate-500" data-testid="text-followup-history-empty">No corrections recorded for this run.</p> : (
          <ul className="space-y-2">
            {history.map((h) => (
              <li key={h.previewId} className="rounded-md border border-slate-800 p-2" data-testid={`row-followup-history-${h.previewId}`}>
                <div className="flex flex-wrap items-center gap-2 text-slate-400">
                  <StateBadge state={h.state} /><span>{h.actor}</span><span className="ml-auto">{fmt(h.expiresAt)}</span>
                </div>
                <ul className="mt-1.5 space-y-1.5">{h.invoices.map((i) => <InvoiceRow key={i.jobId} inv={i} />)}</ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Admin-only, collapsed by default; queries only mount when opened. */
export function AutoPrintFollowupPanel({ runId }: { runId: string }) {
  const { role } = useStaff();
  const [open, setOpen] = useState(false);
  if (role !== "admin") return null;
  return (
    <div className="mt-2 rounded-lg border border-slate-800 bg-[#0f172a] text-[12px]" data-testid={`panel-followup-${runId}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-slate-200 hover:bg-slate-800/40" data-testid={`button-followup-toggle-${runId}`}>
        <ChevronDown size={13} className={open ? "" : "-rotate-90"} /> MERCH status/category correction (admin, no printing)
      </button>
      {open && <div className="border-t border-slate-800 p-3"><FollowupBody runId={runId} /></div>}
    </div>
  );
}
