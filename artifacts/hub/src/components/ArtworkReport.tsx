import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGetArtworkReport,
  getGetArtworkReportQueryKey,
  type GetArtworkReportParams,
  type GetArtworkReportMetric,
  type GetOrdersReportParams,
  type ArtworkCounts,
} from "@workspace/api-client-react";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { formatNumber, formatDate } from "@/lib/format";
import { ChevronLeft, ChevronRight, RefreshCw, X, AlertTriangle } from "lucide-react";

const PAGE = 50;

const METRICS: { key: GetArtworkReportMetric; label: string; hint: string }[] = [
  { key: "total", label: "Invoices", hint: "All matching invoices" },
  { key: "breezy", label: "Breezy observed", hint: "Breezy file seen in current attachments (can overlap Unknown)" },
  { key: "mockup", label: "Mockup observed", hint: "Mockup seen in current attachments (can overlap Unknown)" },
  { key: "both", label: "Both", hint: "Complete snapshot: mockup and Breezy" },
  { key: "mockupOnly", label: "Mockup only", hint: "Complete snapshot: mockup, no Breezy" },
  { key: "breezyOnly", label: "Breezy only", hint: "Complete snapshot: Breezy, no mockup" },
  { key: "neither", label: "Neither", hint: "Complete snapshot: no mockup, no Breezy" },
  { key: "unknown", label: "Unknown", hint: "Stale, missing, partial or truncated attachment snapshot" },
];

const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`);

function toArtworkParams(p: GetOrdersReportParams): GetArtworkReportParams {
  // Artwork report is always invoices (including Merch); orderType is not sent.
  const { orderType: _ignored, ...rest } = p;
  void _ignored;
  return rest as GetArtworkReportParams;
}

function CountButton({ value, label, onClick, active, testId }: { value: number; label: string; onClick: () => void; active: boolean; testId: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} aria-label={`Show ${formatNumber(value)} invoices: ${label}`} data-testid={testId}
      className={`rounded px-1.5 py-0.5 font-mono tabular-nums underline decoration-dotted underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${active ? "bg-emerald-950 text-emerald-300" : "text-slate-200 hover:text-emerald-300"}`}>
      {formatNumber(value)}
    </button>
  );
}

export function ArtworkReport({ params, dateBasis }: { params: GetOrdersReportParams; dateBasis: string }) {
  const base = useMemo(() => toArtworkParams(params), [params]);
  const filterKey = JSON.stringify(base);
  const [sel, setSel] = useState<{ metric: GetArtworkReportMetric; month?: string } | null>(null);
  const [offset, setOffset] = useState(0);
  const invoicePanel = useRef<HTMLDivElement>(null);

  useEffect(() => { setSel(null); setOffset(0); }, [filterKey]);
  useEffect(() => {
    if (sel) invoicePanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sel]);

  const summaryParams: GetArtworkReportParams = { ...base, limit: PAGE, offset: 0 };
  const summary = useGetArtworkReport(summaryParams, { query: { queryKey: getGetArtworkReportQueryKey(summaryParams) } });

  const listParams: GetArtworkReportParams | null = sel ? { ...base, metric: sel.metric, month: sel.month, limit: PAGE, offset } : null;
  const list = useGetArtworkReport(listParams ?? summaryParams, {
    query: { queryKey: getGetArtworkReportQueryKey(listParams ?? summaryParams), enabled: !!listParams },
  });

  const pick = (metric: GetArtworkReportMetric, month?: string) => { setSel({ metric, month }); setOffset(0); };
  const isSel = (metric: GetArtworkReportMetric, month?: string) => sel?.metric === metric && sel?.month === month;
  const refresh = () => { summary.refetch(); if (sel) list.refetch(); };

  const intro = (
    <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400" data-testid="text-artwork-explainer">
      <p><span className="font-medium text-slate-200">Artwork &amp; Proofing.</span> Every record here is an invoice, and Merch invoices are included. This differs from the Orders list and financial reports, so totals may differ from counts elsewhere on this page. Quotes are never counted, whatever the Order Type filter says.</p>
      <p>Counts reflect each invoice's <em>current</em> status and its <em>current</em> attachment snapshot. They do not reconstruct when a mockup or Breezy file was added or infer past proofing workflow.</p>
      <p>Monthly rows are always grouped by invoice date{dateBasis !== "invoice" ? <span className="text-amber-300"> — your date filter uses a different basis, so months may include invoices dated outside the filtered range</span> : null}. Last-year comparison is not available for this tab.</p>
    </div>
  );

  if (summary.isLoading) return <div className="space-y-4">{intro}<div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy="true">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-slate-800/60" />)}</div></div>;
  if (summary.isError || !summary.data) return <div className="space-y-4">{intro}<div role="alert" className="rounded-lg border border-red-900/50 bg-red-950/20 p-6 text-red-300">Unable to load the artwork report. <button type="button" className="underline" onClick={() => summary.refetch()} data-testid="button-artwork-retry">Retry</button></div></div>;

  const data = summary.data;
  const s: ArtworkCounts = data.summary;
  const selLabel = sel ? METRICS.find(m => m.key === sel.metric)?.label : "";
  const listData = list.isFetching ? undefined : list.data;

  return (
    <section className="space-y-4 text-slate-200" data-testid="section-artwork-report">
      {intro}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Click any count to list the exact invoices behind it.</p>
        <button type="button" onClick={refresh} disabled={summary.isFetching} data-testid="button-artwork-refresh"
          className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
          <RefreshCw size={12} className={summary.isFetching ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {s.total === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400" data-testid="text-artwork-empty">No invoices match these filters.</div>
      ) : (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {METRICS.map(m => (
            <button key={m.key} type="button" onClick={() => pick(m.key)} aria-pressed={isSel(m.key)} title={m.hint} data-testid={`stat-artwork-${m.key}`}
              className={`rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${isSel(m.key) ? "border-emerald-500 bg-emerald-950/40" : "border-slate-800 bg-slate-900 hover:border-slate-600"} ${m.key === "unknown" && s.unknown ? "text-amber-200" : ""}`}>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{m.label}</div>
              <div className="mt-1 font-mono text-2xl tabular-nums text-white">{formatNumber(s[m.key])}</div>
              <div className="mt-0.5 text-[11px] leading-tight text-slate-500">{m.hint}</div>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm">
          <div data-testid="text-breezy-percent"><span className="text-slate-400">Breezy observed / all invoices: </span><span className="font-mono text-emerald-300">{pct(data.breezyPercent)}</span></div>
          <div data-testid="text-breezy-of-mockups-percent"><span className="text-slate-400">Breezy among fully checked mockup invoices: </span><span className="font-mono text-emerald-300">{pct(data.breezyOfMockupsPercent)}</span></div>
          <p className="w-full text-[11px] text-slate-500">"Observed" counts can overlap Unknown. The exclusive split (Both, Mockup only, Breezy only, Neither) uses only complete current snapshots; everything stale, missing, partial or truncated is Unknown.</p>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-500">
              <tr><th className="px-4 py-3 text-left">Invoice month</th>{METRICS.map(m => <th key={m.key} className="px-3 py-3 text-right">{m.label}</th>)}</tr>
            </thead>
            <tbody>
              {data.monthly.map(row => (
                <tr key={row.month} className="border-t border-slate-800">
                  <td className="px-4 py-2 font-mono text-slate-300">{row.month}</td>
                  {METRICS.map(m => <td key={m.key} className="px-3 py-2 text-right"><CountButton value={row[m.key]} label={`${m.label}, ${row.month}`} active={isSel(m.key, row.month)} onClick={() => pick(m.key, row.month)} testId={`button-artwork-${row.month}-${m.key}`} /></td>)}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-700 bg-slate-900/60 font-medium">
                <td className="px-4 py-2 text-white">Total</td>
                {METRICS.map(m => <td key={m.key} className="px-3 py-2 text-right"><CountButton value={s[m.key]} label={`${m.label}, all months`} active={isSel(m.key)} onClick={() => pick(m.key)} testId={`button-artwork-total-${m.key}`} /></td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </>)}

      {sel && (
        <div ref={invoicePanel} className="scroll-mt-4 rounded-xl border border-slate-700 bg-slate-900" data-testid="panel-artwork-drilldown">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-white">{selLabel}{sel.month ? ` · ${sel.month}` : " · all months"}{listData ? <span className="ml-2 font-normal text-slate-400">{formatNumber(listData.total)} invoices</span> : null}</h3>
            <button type="button" onClick={() => setSel(null)} aria-label="Close invoice list" data-testid="button-artwork-close" className="rounded p-1 text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"><X size={16} /></button>
          </div>
          {list.isError ? (
            <div role="alert" className="p-6 text-red-300">Unable to load invoices. <button type="button" className="underline" onClick={() => list.refetch()}>Retry</button></div>
          ) : !listData || list.isLoading ? (
            <div className="space-y-2 p-4" aria-busy="true">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-slate-800/60" />)}</div>
          ) : listData.invoices.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-400">No invoices in this group.</p>
          ) : (<>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["Invoice", "Customer", "Current status", "Invoice date", "Current evidence", "Breezy files"].map(h => <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr></thead>
                <tbody>
                  {listData.invoices.map(inv => (
                    <tr key={inv.id} className="border-t border-slate-800 align-top" data-testid={`row-artwork-invoice-${inv.id}`}>
                      <td className="px-4 py-2 font-mono"><PrintavoOrderLink orderId={inv.id} visualId={inv.visualId} />{inv.nickname && <div className="font-sans text-xs text-slate-500">{inv.nickname}</div>}</td>
                      <td className="px-4 py-2">{inv.customer || "—"}</td>
                      <td className="px-4 py-2 text-slate-300">{inv.status || "—"}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-slate-300">{inv.invoiceDate ? formatDate(inv.invoiceDate) : "—"}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1 text-[11px]">
                          <span className={`rounded border px-1.5 py-0.5 ${inv.mockup ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-500"}`}>Mockup {inv.mockup ? "seen" : "not seen"}</span>
                          <span className={`rounded border px-1.5 py-0.5 ${inv.breezy ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-500"}`}>Breezy {inv.breezy ? "seen" : "not seen"}</span>
                          <span className={`rounded border px-1.5 py-0.5 ${inv.complete ? "border-slate-600 text-slate-300" : "border-amber-700 text-amber-300"}`}>{inv.complete ? "Complete snapshot" : "Incomplete snapshot"}</span>
                        </div>
                        {inv.warning && <p className="mt-1 flex items-start gap-1 text-xs text-amber-300"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{inv.warning}</p>}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-300">{inv.filenames.length ? <ul className="space-y-0.5">{inv.filenames.map((f, index) => <li key={`${index}-${f}`} className="break-all font-mono" title={f}>{f}</li>)}</ul> : <span className="text-slate-500">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2 text-xs text-slate-400">
              <span>{formatNumber(listData.offset + 1)}–{formatNumber(listData.offset + listData.invoices.length)} of {formatNumber(listData.total)}</span>
              <div className="flex gap-1">
                <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Previous page" data-testid="button-artwork-prev" className="rounded border border-slate-700 p-1 disabled:opacity-40"><ChevronLeft size={14} /></button>
                <button type="button" disabled={offset + PAGE >= listData.total} onClick={() => setOffset(offset + PAGE)} aria-label="Next page" data-testid="button-artwork-next" className="rounded border border-slate-700 p-1 disabled:opacity-40"><ChevronRight size={14} /></button>
              </div>
            </div>
          </>)}
        </div>
      )}
    </section>
  );
}
