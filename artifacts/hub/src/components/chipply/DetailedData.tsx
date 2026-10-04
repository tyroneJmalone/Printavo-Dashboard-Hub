import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getListChipplyStoresQueryKey, getListDetectedChipplyStoresQueryKey, getGetChipplyStoreQueryKey, getGetChipplySetupQueryKey, type ChipplyDataReconciliation } from "@workspace/api-client-react";

interface Summary {
  lineCount: number; orderCount: number; quantity: number; itemTotalCents: number;
  orderTotalCents: number; orderComponentsCents: Record<string, number>;
  unitComponentsExtendedCents: Record<string, number>;
}
interface Line {
  rowOrdinal: number; orderNumber: string; orderDate: string; productName: string; vendor: string;
  style: string; color: string; size: string; processName: string; plannedMethod: string | null;
  quantity: number; itemTotalCents: number; unitCents: Record<string, number>;
  reconciliation: ChipplyDataReconciliation;
}
interface Preview {
  previewId: string; expiresAt: string; salesOrder: string; storeName: string; sourceHash: string;
  existingStore: { id: string; storeName: string } | null; detectedInvoiceCount: number;
  currentSnapshotId: string | null; requiresReplacement: boolean; summary: Summary; lines: Line[]; warnings: string[];
}
interface Detail {
  storeId: string; snapshotId: string; sourceHash: string; salesOrder: string; storeName: string;
  sourceName: string; importedAt: string; summary: Summary; lines: Line[]; warnings: string[];
  overrides: { rowOrdinal: number; invoiceId: string; reason: string; actor: string; createdAt: string }[];
  versions: { id: string; sourceHash: string; sourceName: string; createdAt: string; actor: string }[];
}
const field = "w-full rounded border border-slate-700 bg-slate-800 p-2 text-sm text-slate-200";
const money = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Not provided" : (value / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const method = (value: string | null) => value ?? "Unresolved";
function InvoiceLink({ visualId }: { visualId: number | null | undefined }) {
  return visualId != null
    ? <a href={`https://www.printavo.com/invoices/${visualId}`} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline" aria-label={`Open Printavo invoice ${visualId} in a new tab`}>#{visualId} ↗</a>
    : <span className="text-slate-400">Invoice number unavailable</span>;
}
function ErrorNotice({ error }: { error: Error | null }) {
  return error ? <p role="alert" className="rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">{error.message}</p> : null;
}
function Totals({ summary }: { summary: Summary }) {
  return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {[["Unique orders", summary.orderCount], ["Source rows", summary.lineCount], ["Quantity", summary.quantity], ["Line sales", money(summary.itemTotalCents)], ["Store order total", money(summary.orderTotalCents)]].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-800 p-3"><p className="text-xs text-slate-400">{label}</p><p className="font-semibold text-white">{value}</p></div>)}
    </div>
    <p className="text-xs text-slate-400">Line sales and order totals are different measures. Repeated order-level amounts are counted once per order, not once per product row. Combined already includes product and process price. Missing values are not $0. Chipply sales are not additional Printavo revenue.</p>
    <details className="text-sm"><summary className="cursor-pointer text-emerald-400">Financial components & methodology</summary>
      <div className="grid gap-4 pt-3 md:grid-cols-2">{[["Order amounts · once per order", summary.orderComponentsCents], ["Unit amounts × quantity", summary.unitComponentsExtendedCents]].map(([title, values]) => <div key={String(title)}><h4 className="font-semibold">{String(title)}</h4>{Object.entries(values as Record<string, number>).map(([key, value]) => <div key={key} className="flex justify-between gap-4 text-xs py-1"><span className="text-slate-400">{key}</span><span>{money(value)}</span></div>)}</div>)}</div>
      <p className="mt-2 text-xs text-slate-400">Fundraising is not net profit. Components are explanatory, not additional sales to sum into the totals.</p>
    </details>
  </div>;
}
function Lines({ lines, onReview }: { lines: Line[]; onReview?: (line: Line) => void }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const selected = lines.filter(line => !filter || line.reconciliation.outcome === filter);
  const counts = lines.reduce<Record<string, number>>((all, line) => { all[line.reconciliation.outcome] = (all[line.reconciliation.outcome] ?? 0) + 1; return all; }, {});
  return <div className="space-y-3">
    <label className="block text-xs text-slate-400">Reconciliation status
      <select aria-label="Reconciliation status" className={`${field} mt-1 max-w-xs`} value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}><option value="">All rows ({lines.length})</option>{Object.entries(counts).map(([key, value]) => <option key={key} value={key}>{key} ({value})</option>)}</select>
    </label>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-slate-400"><tr>{["Row / date", "Product", "Process · planned", "Qty / line sales", "Actual / invoice", "Evidence"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{selected.slice(page * 30, (page + 1) * 30).map(line => <tr key={line.rowOrdinal} className="border-t border-slate-800 align-top">
      <td className="p-2 whitespace-nowrap">{line.rowOrdinal}<br />{line.orderDate}</td>
      <td className="p-2 min-w-40">{line.productName}<p className="text-slate-400">{line.vendor} · {line.style} · {line.color} · {line.size}</p></td>
      <td className="p-2 min-w-40">{line.processName}<p className="text-slate-400">{method(line.plannedMethod)}</p></td>
      <td className="p-2">{line.quantity}<br />{money(line.itemTotalCents)}</td>
      <td className="p-2">{method(line.reconciliation.actualMethod)}<p className="text-slate-400">{line.reconciliation.invoiceId ? <InvoiceLink visualId={line.reconciliation.invoiceVisualId} /> : "No verified invoice"}</p>
        {!line.reconciliation.invoiceId && (line.reconciliation.candidateInvoices ?? []).map(candidate => <p key={candidate.invoiceId} className="mt-1 text-slate-400">Candidate (not verified): <InvoiceLink visualId={candidate.visualId} /></p>)}
      </td>
      <td className="p-2 min-w-64"><strong className={["matched", "reviewed"].includes(line.reconciliation.outcome) ? "text-emerald-400" : "text-amber-300"}>{line.reconciliation.outcome}</strong><p className="mt-1 text-slate-400">{line.reconciliation.reason}</p>
        {onReview && line.reconciliation.candidateInvoiceIds.length > 0 && <button className="mt-2 text-emerald-400 underline" onClick={() => onReview(line)}>Review invoice choice</button>}
        {onReview && !line.reconciliation.candidateInvoiceIds.length && <p className="mt-1 text-slate-500">No supported invoice choice; cannot resolve here.</p>}
      </td>
    </tr>)}</tbody></table></div>
    {!selected.length && <p className="text-sm text-slate-400">No rows in this status.</p>}
    <div className="flex items-center gap-3 text-xs"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><span>{selected.length ? page * 30 + 1 : 0}–{Math.min((page + 1) * 30, selected.length)} of {selected.length}</span><Button size="sm" variant="outline" disabled={(page + 1) * 30 >= selected.length} onClick={() => setPage(page + 1)}>Next</Button></div>
  </div>;
}
export function DetailedDataImport({ expectedStoreId, onSaved, open: controlledOpen, onOpenChange, hideTrigger }: { expectedStoreId?: string; onSaved?: (storeId: string) => void; open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean } = {}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = (next: boolean) => { if (onOpenChange) onOpenChange(next); else setInnerOpen(next); };
  return <>{!hideTrigger && <Button data-testid="button-import-detailed" variant="outline" onClick={() => setOpen(true)}>Import detailed data · CSV / XLSX</Button>}<Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto bg-slate-900 border-slate-700 text-slate-200 sm:max-w-6xl"><DialogHeader><DialogTitle>Import detailed Chipply data</DialogTitle><DialogDescription>Upload the detailed data export, review its store and totals, then confirm. Saves only in Hub; no Printavo writeback.</DialogDescription></DialogHeader>{open && <ImportReview expectedStoreId={expectedStoreId} onSaved={onSaved} />}</DialogContent></Dialog></>;
}
/** Reports pending writes so an embedding page can block navigation until they settle. */
function useBusyReport(busy: boolean, onBusyChange?: (busy: boolean) => void) {
  const ref = useRef(onBusyChange); ref.current = onBusyChange;
  useEffect(() => { ref.current?.(busy); }, [busy]);
  useEffect(() => () => ref.current?.(false), []);
}
export function ImportReview({ expectedStoreId, onSaved, onBusyChange }: { expectedStoreId?: string; onSaved?: (storeId: string) => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const client = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [replace, setReplace] = useState(false);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error("Choose a CSV or XLSX detailed data export.");
      if (file.size > 5 * 1024 * 1024) throw new Error("File exceeds 5 MB.");
      const body = new FormData(); body.append("file", file); if (expectedStoreId) body.append("expectedStoreId", expectedStoreId);
      return apiFetch<Preview>("/chipply/data/preview", { method: "POST", body });
    },
    onSuccess: data => { setPreview(data); setReplace(false); },
  });
  const confirm = useMutation({
    mutationFn: () => apiFetch<{ storeId: string; snapshotId: string; idempotent: boolean }>("/chipply/data/confirm", { method: "POST", body: JSON.stringify({ previewId: preview!.previewId, replaceCurrent: replace }) }),
    onSuccess: data => {
      client.invalidateQueries({ queryKey: getListChipplyStoresQueryKey() });
      client.invalidateQueries({ queryKey: getListDetectedChipplyStoresQueryKey() });
      client.invalidateQueries({ queryKey: getGetChipplyStoreQueryKey(data.storeId) });
      client.invalidateQueries({ queryKey: ["chipply-detailed-data", data.storeId] });
      client.invalidateQueries({ queryKey: getGetChipplySetupQueryKey(data.storeId) });
      onSaved?.(data.storeId);
    },
  });
  useBusyReport(upload.isPending || confirm.isPending, onBusyChange);
  if (confirm.data) return <div role="status" className="space-y-3 p-4"><h3 className="font-semibold text-emerald-400">{confirm.data.idempotent ? "Identical import already saved — no duplicate created" : "Detailed snapshot saved in Hub"}</h3>{!expectedStoreId && <Link href={`/chipply/${confirm.data.storeId}`} className="text-emerald-400 underline">Open store financials and reconciliation</Link>}</div>;
  return <div className="space-y-4">
    <label className="block text-sm">Detailed data export (.csv or .xlsx, up to 5 MB)<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className={`${field} mt-2`} disabled={upload.isPending || confirm.isPending} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) { setPreview(null); confirm.reset(); upload.mutate(file); } }} /></label>
    {expectedStoreId && <p className="rounded border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-200">Scoped to this store: Hub rejects an export whose sales order belongs to a different store.</p>}
    <p className="text-xs text-slate-400">Closing email and SalesReport imports remain under “Import store”. Margin Reports still attach on the store page. This option is for row-level detailed exports only; buyer contact information is not shown.</p>
    {upload.isPending && <p role="status">Reading and matching the export…</p>}<ErrorNotice error={upload.error} /><ErrorNotice error={confirm.error} />
    {preview && <>
      <div className="rounded-lg border border-slate-700 p-3"><h3 className="font-semibold text-white">{preview.storeName} · Event {preview.salesOrder}</h3><p className="text-sm text-slate-400">{preview.existingStore ? `Matched existing store: ${preview.existingStore.storeName}` : "New store — name and event will be prefilled from this export."} · {preview.detectedInvoiceCount} detected Printavo invoices</p><p className="break-all text-xs text-slate-500 mt-2">Source SHA-256: {preview.sourceHash}</p><p className="text-xs text-slate-500">Preview expires: {new Date(preview.expiresAt).toLocaleString()}</p></div>
      <Totals summary={preview.summary} />
      {preview.warnings.map((warning, i) => <p key={i} className="text-xs text-amber-300">{warning}</p>)}
      <Lines lines={preview.lines} />
      {preview.requiresReplacement && <label className="flex gap-2 rounded border border-amber-800 p-3 text-sm text-amber-200"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />I authorize replacing this store’s current detailed snapshot if the file differs. Prior versions remain in history; an identical import creates no duplicate.</label>}
      <p className="text-xs text-slate-400">Confirming saves this reviewed snapshot locally in Hub. It does not modify Printavo invoices or categories.</p>
      <Button disabled={confirm.isPending || (preview.requiresReplacement && !replace)} onClick={() => confirm.mutate()}>{confirm.isPending ? "Saving…" : "Confirm and save to Hub"}</Button>
    </>}
  </div>;
}
export function DetailedStoreData({ storeId, onBusyChange }: { storeId: string; onBusyChange?: (busy: boolean) => void }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["chipply-detailed-data", storeId], queryFn: async () => {
    try { return await apiFetch<Detail>(`/chipply/data/stores/${encodeURIComponent(storeId)}`); }
    catch (error) {
      if (error instanceof Error && error.message === "No detailed Data Export imported for this store") return null;
      throw error;
    }
  } });
  const [review, setReview] = useState<Line | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => apiFetch(`/chipply/data/stores/${encodeURIComponent(storeId)}/overrides`, { method: "POST", body: JSON.stringify({ snapshotId: reviewSnapshot, rowOrdinal: review!.rowOrdinal, invoiceId, reason: reason.trim() }) }),
    onSuccess: () => { setReview(null); client.invalidateQueries({ queryKey: ["chipply-detailed-data", storeId] }); client.invalidateQueries({ queryKey: getGetChipplySetupQueryKey(storeId) }); },
  });
  useBusyReport(save.isPending, onBusyChange);
  const data = query.data;
  return <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-slate-200">
    <div className="flex flex-wrap justify-between gap-3"><h2 className="font-bold text-white">Detailed financials & process reconciliation</h2><Button size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Refresh mirror comparison</Button></div>
    <p className="text-xs text-slate-400">Compared against current locally mirrored Printavo details on each refresh, not a live external fetch. No writeback or automatic category changes. Mixed methods remain a separate bucket, never allocated to single methods.</p>
    <Link href="/chipply?tab=categories" className="inline-block text-xs text-emerald-400 underline">Open existing invoice category tool</Link>
    {query.isLoading && <p role="status">Loading detailed snapshot…</p>}<ErrorNotice error={query.error} />
    {!query.isLoading && !query.error && !data && <p className="text-sm text-slate-400">No detailed snapshot imported. Import a detailed CSV or XLSX from Chipply Stores; missing financials are not zero.</p>}
    {data && <>
      <p className="text-xs text-slate-400">{data.sourceName} · Imported {new Date(data.importedAt).toLocaleString()} · Event {data.salesOrder}</p><p className="break-all text-xs text-slate-500">SHA-256: {data.sourceHash}</p>
      <Totals summary={data.summary} />
      <div className="grid gap-3 md:grid-cols-2">{(["plannedMethod", "actualMethod"] as const).map(kind => {
        const groups = new Map<string, { quantity: number; sales: number }>();
        for (const line of data.lines) { const key = method(kind === "plannedMethod" ? line.plannedMethod : line.reconciliation.actualMethod); const value = groups.get(key) ?? { quantity: 0, sales: 0 }; value.quantity += line.quantity; value.sales += line.itemTotalCents; groups.set(key, value); }
        return <div key={kind} className="rounded border border-slate-700 p-3"><h3 className="text-sm font-semibold">{kind === "plannedMethod" ? "Planned process" : "Verified actual process"} · Chipply line sales</h3>{[...groups].map(([name, value]) => <div key={name} className="flex justify-between gap-3 py-1 text-xs"><span>{name}</span><span>{value.quantity} units · {money(value.sales)}</span></div>)}</div>;
      })}</div>
      {data.warnings.map((warning, i) => <p key={i} className="text-xs text-amber-300">{warning}</p>)}
      <Lines lines={data.lines} onReview={line => { setReview(line); setReviewSnapshot(data.snapshotId); setInvoiceId(line.reconciliation.invoiceId ?? ""); setReason(""); save.reset(); }} />
      <details><summary className="cursor-pointer text-sm text-emerald-400">Source versions & manual review history</summary><div className="space-y-2 pt-2 text-xs">{data.versions.map(version => <p key={version.id} className="break-all">{version.sourceName} · {new Date(version.createdAt).toLocaleString()} · {version.sourceHash}{version.id === data.snapshotId ? " · Current" : ""}</p>)}{data.overrides.map((override, i) => <p key={i}>Row {override.rowOrdinal} → invoice {override.invoiceId} · {override.reason} · {override.actor} · {new Date(override.createdAt).toLocaleString()}</p>)}</div></details>
    </>}
    <Dialog open={!!review} onOpenChange={open => { if (!open && !save.isPending) setReview(null); }}><DialogContent className="bg-slate-900 border-slate-700 text-slate-200"><DialogHeader><DialogTitle>Review invoice choice · row {review?.rowOrdinal}</DialogTitle><DialogDescription>This is a local audited selection, not a production-method override. The server validates the complete process group and quantity coverage. Unsupported or incomplete evidence cannot be forced.</DialogDescription></DialogHeader>
      <p className="text-sm">{review?.processName} · {review?.style} / {review?.color} / {review?.size}</p>
      <label className="text-xs">Candidate invoice<select className={`${field} mt-1`} value={invoiceId} onChange={e => setInvoiceId(e.target.value)}><option value="">Choose an invoice</option>{review?.reconciliation.candidateInvoices.map(candidate => <option key={candidate.invoiceId} value={candidate.invoiceId}>{candidate.visualId != null ? `Invoice #${candidate.visualId}` : "Invoice number unavailable"}</option>)}</select></label>
      {invoiceId && <p className="text-xs">Open selected invoice: <InvoiceLink visualId={review?.reconciliation.candidateInvoices.find(candidate => candidate.invoiceId === invoiceId)?.visualId} /></p>}
      <label className="text-xs">Reason (5–1,000 characters required)<textarea className={`${field} mt-1`} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain the evidence for this invoice choice" /></label><ErrorNotice error={save.error} />
      <Button disabled={!invoiceId || reason.trim().length < 5 || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Validating…" : "Validate and record local choice"}</Button>
    </DialogContent></Dialog>
  </section>;
}