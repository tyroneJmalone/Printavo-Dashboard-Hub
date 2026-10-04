import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getListChipplyStoresQueryKey, getListDetectedChipplyStoresQueryKey, getGetChipplyStoreQueryKey, getGetChipplySetupQueryKey, ApiError, type ChipplySummarySource, type ChipplySummaryComparison, type ChipplySummaryReviewRow, type ChipplySummaryPreview, type ChipplySummaryResult, type ChipplyStoreSummaryResponse } from "@workspace/api-client-react";
import { AlertTriangle, Check, ExternalLink, FileText, Loader2, ShieldCheck } from "lucide-react";

export type SummarySource = ChipplySummarySource;
export type SummaryComparison = ChipplySummaryComparison;
export type ComparisonAction = SummaryComparison["action"];
export type SummaryReviewRow = ChipplySummaryReviewRow;
export type SummaryPreview = ChipplySummaryPreview;
export type SummaryConfirmResult = ChipplySummaryResult;
export type StoreSummaryEnvelope = ChipplyStoreSummaryResponse;

export const summaryStoreKey = (id: string) => ["/api/chipply/summary/stores", id] as const;
const field = "w-full rounded border border-slate-700 bg-slate-800 p-2 text-sm text-slate-200";
const is409 = (e: unknown) => (e instanceof ApiError && e.status === 409) || (e instanceof Error && "status" in e && (e as { status?: number }).status === 409);

/** Missing stays "Not provided" — never shown as 0. Zero stays 0. */
export function fmt(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === "") return <span className="italic text-slate-500">Not provided</span>;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleDateString();
  return String(v);
}
const ACTION: Record<ComparisonAction, { label: string; cls: string }> = {
  fill: { label: "Fills blank", cls: "bg-emerald-950/60 text-emerald-300 border-emerald-800" },
  conflict: { label: "Differs · not overwritten", cls: "bg-amber-950/50 text-amber-300 border-amber-800" },
  same: { label: "No change", cls: "bg-slate-800 text-slate-400 border-slate-700" },
  source: { label: "Source only", cls: "bg-sky-950/60 text-sky-300 border-sky-800" },
  retained: { label: "Kept Hub value", cls: "bg-indigo-950/50 text-indigo-300 border-indigo-800" },
};
function ActionPill({ a }: { a: ComparisonAction }) {
  return <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide whitespace-nowrap ${ACTION[a].cls}`}>{ACTION[a].label}</span>;
}
const SOURCE_NOTE = "Order count may fill a blank Hub order count; it is not garment quantity. Reported Sales stays separate because its financial definition is unverified. Sales and process counts are never added to Hub or Printavo revenue. A source status of Complete does not mean production is complete. Blank is not zero.";

function useBusyReport(busy: boolean, onBusyChange?: (b: boolean) => void) {
  const ref = useRef(onBusyChange); ref.current = onBusyChange;
  useEffect(() => { ref.current?.(busy); }, [busy]);
  useEffect(() => () => ref.current?.(false), []);
}

function ComparisonTable({ rows, testPrefix, actions }: { rows: SummaryComparison[]; testPrefix: string; actions?: (c: SummaryComparison) => ReactNode }) {
  if (!rows.length) return <p className="text-xs text-slate-500">No field comparisons.</p>;
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs">
    <thead className="text-slate-500"><tr><th className="p-1.5">Field</th><th className="p-1.5">Hub now</th><th className="p-1.5">Summary file</th><th className="p-1.5">Result</th>{actions && <th className="p-1.5" />}</tr></thead>
    <tbody>{rows.map((c) => <tr key={c.evidenceKey} data-testid={`row-${testPrefix}-${c.field}`} className="border-t border-slate-800 align-top">
      <td className="p-1.5 text-slate-300">{c.label}</td>
      <td className="p-1.5 text-slate-200">{c.action === "source" ? <span className="text-slate-600">n/a</span> : fmt(c.current)}</td>
      <td className="p-1.5 text-slate-200">{fmt(c.incoming)}</td>
      <td className="p-1.5"><ActionPill a={c.action} /></td>
      {actions && <td className="p-1.5">{actions(c)}</td>}
    </tr>)}</tbody>
  </table></div>;
}

/** Upload → review → explicit row selection → confirm. Blank fills only; never overwrites. */
export function SummaryImportReview({ expectedStoreId, onSaved, onBusyChange }: { expectedStoreId?: string; onSaved?: (r: SummaryConfirmResult) => void; onBusyChange?: (b: boolean) => void }) {
  const client = useQueryClient();
  const [preview, setPreview] = useState<SummaryPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!/\.csv$/i.test(file.name)) throw new Error("Choose a Store Summary CSV file.");
      if (file.size > 2 * 1024 * 1024) throw new Error("File exceeds 2 MB.");
      const body = new FormData(); body.append("file", file); if (expectedStoreId) body.append("expectedStoreId", expectedStoreId);
      return apiFetch<SummaryPreview>("/chipply/summary/preview", { method: "POST", body });
    },
    onSuccess: (d) => { setPreview(d); setSelected(new Set()); },
  });
  const confirm = useMutation({
    mutationFn: () => apiFetch<SummaryConfirmResult>("/chipply/summary/confirm", { method: "POST", body: JSON.stringify({ previewId: preview!.previewId, selectedSalesOrders: [...selected] }) }),
    retry: false,
    onSuccess: (d) => {
      client.invalidateQueries({ queryKey: getListChipplyStoresQueryKey() });
      client.invalidateQueries({ queryKey: getListDetectedChipplyStoresQueryKey() });
      for (const s of d.stores) {
        client.invalidateQueries({ queryKey: getGetChipplyStoreQueryKey(s.storeId) });
        client.invalidateQueries({ queryKey: getGetChipplySetupQueryKey(s.storeId) });
        client.invalidateQueries({ queryKey: summaryStoreKey(s.storeId) });
      }
      onSaved?.(d);
    },
  });
  useBusyReport(upload.isPending || confirm.isPending, onBusyChange);

  const rows = useMemo(() => {
    if (!preview) return [];
    return expectedStoreId ? preview.rows.filter((r) => r.storeId === expectedStoreId) : preview.rows;
  }, [preview, expectedStoreId]);
  const hiddenCount = preview && expectedStoreId ? preview.rows.length - rows.length : 0;
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const busy = upload.isPending || confirm.isPending;

  if (confirm.data) return <div role="status" data-testid="status-summary-saved" className="space-y-3 rounded-lg border border-emerald-900 bg-emerald-950/20 p-4">
    <h3 className="font-semibold text-emerald-300 flex items-center gap-2"><Check size={16} />{confirm.data.idempotent ? "Already recorded — nothing new was written" : "Summary recorded in Hub"}</h3>
    <ul className="space-y-1.5 text-sm">{confirm.data.stores.map((s) => <li key={s.storeId} className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-slate-300">Event {s.eventId}</span>
      <span className="text-slate-400">{s.created ? "new store created" : "existing store"} · {s.filledFields.length ? `filled blanks: ${s.filledFields.join(", ")}` : "no blanks filled"}</span>
      {!expectedStoreId && <><Link data-testid={`link-summary-store-${s.storeId}`} href={`/chipply/${s.storeId}`} className="text-emerald-400 underline">Store</Link><Link data-testid={`link-summary-guide-${s.storeId}`} href={`/chipply/${s.storeId}/setup`} className="text-emerald-400 underline">Guide</Link></>}
    </li>)}</ul>
  </div>;

  return <div className="space-y-4">
    <label className="block text-sm">Chipply Store Summary (.csv, up to 2 MB)
      <input data-testid="input-summary-file" type="file" accept=".csv,text/csv" className={`${field} mt-2`} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { setPreview(null); confirm.reset(); upload.mutate(f); } }} />
    </label>
    <p className="text-xs text-slate-400">Preview does not change any stores. Blank-fill only: after you confirm, Hub fills empty fields on stores you select and records the source summary. Existing Hub values are never overwritten; differences are listed for review. Nothing is written to Printavo.</p>
    {expectedStoreId && <p data-testid="text-summary-scope" className="rounded border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-200">Scoped to this store. The file may list many stores; only this store's row is shown and can be confirmed here.</p>}
    {upload.isPending && <p role="status" className="text-sm text-slate-300"><Loader2 size={13} className="inline animate-spin mr-1.5" />Reading the summary…</p>}
    {upload.error && <p role="alert" className="rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">{upload.error.message}</p>}
    {confirm.error && <p role="alert" data-testid="status-summary-error" className="rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">Not saved: {confirm.error.message}{is409(confirm.error) && " Store data changed or the preview expired. Upload the file again to review fresh comparisons; nothing was overwritten."}</p>}
    {preview && <>
      <div className="rounded-lg border border-slate-700 p-3 text-xs text-slate-400 flex flex-wrap gap-x-4 gap-y-1"><span className="text-slate-200 font-semibold flex items-center gap-1.5"><FileText size={13} />{preview.sourceName}</span><span>{preview.rows.length} rows in file</span><span>Preview expires {new Date(preview.expiresAt).toLocaleString()}</span></div>
      {preview.warnings.map((w, i) => <p key={i} className="text-xs text-amber-300">{w}</p>)}
      {hiddenCount > 0 && <p className="text-xs text-slate-500">{hiddenCount} other store row{hiddenCount === 1 ? "" : "s"} in this file hidden — import them from Chipply Stores.</p>}
      <p className="text-[11px] text-slate-500">{SOURCE_NOTE}</p>
      {rows.length === 0 && <p className="rounded border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">{expectedStoreId ? "This file has no row for this store's event. Nothing can be confirmed here." : "No rows found."}</p>}
      {!expectedStoreId && <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" data-testid="button-select-all-summary" disabled={busy || !rows.some(r => r.supported)} onClick={() => setSelected(new Set(rows.filter(r => r.supported).map(r => r.eventId)))}>Select all supported stores</Button>
          <Button size="sm" variant="outline" data-testid="button-select-new-summary" disabled={busy || !rows.some(r => r.supported && !r.storeId)} onClick={() => setSelected(new Set(rows.filter(r => r.supported && !r.storeId).map(r => r.eventId)))}>Select new stores only</Button>
          <Button size="sm" variant="outline" data-testid="button-select-existing-summary" disabled={busy || !rows.some(r => r.supported && r.storeId)} onClick={() => setSelected(new Set(rows.filter(r => r.supported && r.storeId).map(r => r.eventId)))}>Select existing stores only</Button>
          <Button size="sm" variant="outline" data-testid="button-clear-summary" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
        <p role="status" data-testid="text-summary-selection" className="text-xs text-slate-300">
          {selected.size} selected: {rows.filter(r => selected.has(r.eventId) && !r.storeId).length} new stores to create, {rows.filter(r => selected.has(r.eventId) && r.storeId).length} existing stores to check for blank fields. Unsupported rows are excluded.
        </p>
        <Button data-testid="button-confirm-summary-top" disabled={busy || selected.size === 0} onClick={() => confirm.mutate()} className="bg-[#059669] hover:bg-[#047857] text-white">{confirm.isPending ? <><Loader2 size={14} className="mr-1.5 animate-spin" />Importing…</> : `Import ${selected.size} selected stores`}</Button>
      </div>}
      <div className="space-y-2">{rows.map((r) => {
        const on = selected.has(r.eventId);
        return <div key={r.eventId} data-testid={`card-summary-row-${r.eventId}`} className={`rounded-lg border p-3 space-y-2 ${!r.supported ? "border-slate-800 opacity-60" : on ? "border-[#059669] bg-emerald-950/10" : "border-slate-700"}`}>
          <div className="flex flex-wrap items-center gap-3">
            {r.supported
              ? <input type="checkbox" data-testid={`checkbox-summary-${r.eventId}`} checked={on} disabled={busy} onChange={() => toggle(r.eventId)} className="h-4 w-4 accent-[#059669]" aria-label={`Select event ${r.eventId}`} />
              : <span className="text-[10px] font-bold uppercase text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">Skipped</span>}
            <span className="font-semibold text-white">{r.storeName}</span>
            <span className="font-mono text-xs text-slate-400">Event {r.eventId}</span>
            <span className="text-xs text-slate-500">{r.storeType}</span>
            <span className={`text-xs ${r.storeId ? "text-sky-300" : "text-emerald-300"}`}>{!r.supported ? "Unsupported store type (Catalog Batch) — not importable" : r.storeId ? "Existing store" : "New Group store — created only if selected"}</span>
          </div>
          {r.supported && <details open={!!expectedStoreId}><summary className="cursor-pointer text-xs text-slate-400">Review fields · {r.comparisons.filter(c => c.action === "fill").length} blank fills · {r.comparisons.filter(c => c.action === "conflict").length} differences</summary><ComparisonTable rows={r.comparisons} testPrefix={`preview-${r.eventId}`} /></details>}
        </div>;
      })}</div>
      <div className="flex flex-wrap items-center gap-3">
        <Button data-testid="button-confirm-summary" disabled={busy || selected.size === 0} onClick={() => confirm.mutate()} className="bg-[#059669] hover:bg-[#047857] text-white">{confirm.isPending ? <><Loader2 size={14} className="mr-1.5 animate-spin" />Importing…</> : `Import ${selected.size} selected stores`}</Button>
        <span className="text-xs text-slate-500">Rows are unselected by default. Only checked rows are written.</span>
      </div>
    </>}
  </div>;
}

export function SummaryImportDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved?: (r: SummaryConfirmResult) => void }) {
  const [busy, setBusy] = useState(false);
  return <Dialog open={open} onOpenChange={(o) => { if (!o && busy) return; onOpenChange(o); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto bg-slate-900 border-slate-700 text-slate-200 sm:max-w-5xl" onInteractOutside={(e) => { if (busy) e.preventDefault(); }} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}>
      <DialogHeader><DialogTitle>Import Chipply Store Summary</DialogTitle><DialogDescription>Fills blank store fields only and records the source summary for review. Saves in Hub only.</DialogDescription></DialogHeader>
      {open && <SummaryImportReview onSaved={onSaved} onBusyChange={setBusy} />}
    </DialogContent>
  </Dialog>;
}

const EDITABLE: Record<string, string> = { storeName: "identity", eventId: "identity", closedAt: "identity", contact: "identity", orgContact: "identity", storeAdmin: "identity", orders: "identity", numOrders: "identity" };

/** Persisted source summary + discrepancies with explicit "Keep Hub value". */
export function SummaryPanel({ storeId, disabled, onLeave, onBusyChange, compact, readOnly }: { readOnly?: boolean; storeId: string; disabled?: boolean; onLeave?: (to: string) => void; onBusyChange?: (b: boolean) => void; compact?: boolean }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: summaryStoreKey(storeId), queryFn: () => apiFetch<StoreSummaryEnvelope>(`/chipply/summary/stores/${encodeURIComponent(storeId)}`), enabled: !!storeId });
  const [importing, setImporting] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const retain = useMutation({
    mutationFn: (c: SummaryComparison) => apiFetch<StoreSummaryEnvelope>(`/chipply/summary/stores/${encodeURIComponent(storeId)}/retain`, { method: "POST", body: JSON.stringify({ field: c.field, evidenceKey: c.evidenceKey }) }),
    retry: false,
    onSuccess: (d) => { client.setQueryData(summaryStoreKey(storeId), d); client.invalidateQueries({ queryKey: getGetChipplySetupQueryKey(storeId) }); },
    onError: (e) => { if (is409(e)) void q.refetch(); },
  });
  useBusyReport(retain.isPending || importBusy, onBusyChange);
  const s = q.data?.summary;
  const block = disabled || retain.isPending || importBusy;

  if (q.isLoading) return <div className="h-20 rounded-lg bg-slate-800 animate-pulse" />;
  if (q.error) return <div role="alert" className="rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-200 flex items-center gap-3"><span className="flex-1">Couldn't load source summary: {q.error.message}</span><Button size="sm" variant="outline" onClick={() => void q.refetch()}>Retry</Button></div>;

  return <section data-testid="panel-source-summary" className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2"><ShieldCheck size={14} className="text-sky-400" />Chipply Store Summary <span className="text-[10px] font-normal text-slate-500">optional</span></h3>
      {s && <span data-testid="text-summary-unresolved" className={`text-xs ${s.unresolvedCount ? "text-amber-300" : "text-emerald-300"}`}>{s.unresolvedCount ? `${s.unresolvedCount} difference${s.unresolvedCount === 1 ? "" : "s"} to review` : "No outstanding differences"}</span>}
    </div>
    {!s ? <div className="space-y-2">
      <p className="text-xs text-slate-400">No summary recorded for this store. A summary is optional; it fills blank fields and flags differences without overwriting Hub.</p>
      {readOnly ? <Link data-testid="link-summary-guide" href={`/chipply/${storeId}/setup`} className="text-xs text-emerald-400 underline">Import from Guided Setup step 1</Link> : !importing ? <Button size="sm" variant="outline" data-testid="button-summary-import-scoped" disabled={block} onClick={() => setImporting(true)}>Import Store Summary CSV</Button>
        : <SummaryImportReview expectedStoreId={storeId} onBusyChange={setImportBusy} />}
    </div> : <>
      <p data-testid="text-summary-source" className="text-xs text-slate-500">Source: {s.sourceName} · imported {new Date(s.importedAt).toLocaleString()} · status in file: {s.source.status ?? "not provided"} (not production status)</p>
      {retain.error && <p role="alert" className="rounded border border-red-800 bg-red-950/30 p-2 text-xs text-red-200">Not saved: {retain.error.message}{is409(retain.error) && " The comparison changed; the latest is loaded."}</p>}
      {<ComparisonTable rows={compact ? s.comparisons.filter((c) => c.action !== "same") : s.comparisons} testPrefix="summary" actions={readOnly ? undefined : (c) => {
        if (c.action !== "conflict") return null;
        const section = EDITABLE[c.field];
        return <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" data-testid={`button-keep-hub-${c.field}`} disabled={block} onClick={() => retain.mutate(c)} className="h-7 text-xs">{retain.isPending && retain.variables?.evidenceKey === c.evidenceKey ? <Loader2 size={12} className="animate-spin" /> : "Keep Hub value"}</Button>
          {section && onLeave && <button type="button" data-testid={`link-correct-${c.field}`} disabled={block} onClick={() => onLeave(`/chipply/${storeId}?setup=1&section=${section}`)} className="inline-flex items-center gap-1 text-xs text-emerald-400 underline disabled:opacity-50">Edit in store <ExternalLink size={10} /></button>}
          {!section && <span className="text-[10px] text-slate-500">No Hub editor for this field</span>}
        </div>;
      }} />}
      {readOnly && <Link data-testid="link-summary-review" href={`/chipply/${storeId}/setup`} className="inline-block text-xs text-emerald-400 underline">Review differences in Guided Setup</Link>}
      <p className="text-[11px] text-slate-500 flex gap-1.5"><AlertTriangle size={11} className="shrink-0 mt-0.5" />{SOURCE_NOTE} Keep Hub value only marks that difference reviewed; nothing is overwritten.</p>
      {!readOnly && (!importing ? <Button size="sm" variant="outline" disabled={block} onClick={() => setImporting(true)}>Import newer Store Summary CSV</Button> : <SummaryImportReview expectedStoreId={storeId} onBusyChange={setImportBusy} onSaved={() => setImporting(false)} />)}
    </>}
  </section>;
}
