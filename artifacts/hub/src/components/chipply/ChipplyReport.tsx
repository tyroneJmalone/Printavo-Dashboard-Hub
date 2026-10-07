import { useState } from "react";
import { ReportDatePresets } from "@/components/ReportDatePresets";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "../../../../../lib/api-client-react/src/custom-fetch";

interface ReportLine {
  storeId: string; storeName: string; eventId: string | null; customer: string | null;
  closedAt: string | null; transactionDate: string | null; rowOrdinal: number; orderNumber: string;
  plannedMethod: string | null; actualMethod: string | null; methodChanged: boolean | null;
  outcome: string; reason: string | null; status: string | null; nickname: string | null;
  vendor: string | null; product: string | null; style: string | null; color: string | null;
  size: string | null; quantity: number; itemTotalCents: number;
}
interface Report {
  source: "chipply";
  summary: { lineCount: number; storeCount: number; orderCount: number; quantity: number; itemTotalCents: number; unallocatedItemTotalCents: number };
  lines: ReportLine[];
  coverage: { scope: string; totalStores: number; storesWithDetailedFinancials: number; missingStores: { storeId: string; storeName: string }[]; linesMissingTransactionDate: number; linesMissingClosedDate: number };
  warnings: string[];
}
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const methods = ["screenprint", "heat-transfer", "embroidery", "dtg", "engraving", "mixed"];
const inputClass = "w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100";

export function ReportSourceSelector({ source, onChange }: { source: string; onChange: (source: "printavo" | "chipply") => void }) {
  return <label className="flex items-center gap-3 border-b border-slate-800 bg-slate-950 px-6 py-3 text-sm text-slate-300">
    Source / channel
    <select aria-label="Report source / channel" className="rounded border border-slate-700 bg-slate-900 p-2 text-white" value={source} onChange={e => onChange(e.target.value as "printavo" | "chipply")}>
      <option value="printavo">Standard Printavo (excludes Chipply shells)</option>
      <option value="chipply">Chipply stores (separate revenue)</option>
    </select>
  </label>;
}
export function ChipplyReport() {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const q = new URLSearchParams(window.location.search);
    const init: Record<string, string> = { dateBasis: q.get("dateBasis") === "transaction" ? "transaction" : "closed" };
    for (const key of ["store", "start", "end"]) { const v = q.get(key); if (v) init[key] = v; }
    return init;
  });
  const [filters, setFilters] = useState(draft);
  const [page, setPage] = useState(0);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  const url = `/api/reports/chipply?${params}`;
  const query = useQuery({ queryKey: ["chipply-report", filters], queryFn: () => customFetch<Report>(url) });
  const change = (key: string, value: string) => setDraft(prev => ({ ...prev, [key]: value }));
  async function exportCsv() {
    setExportError(""); setExporting(true);
    try {
      const blob = await customFetch<Blob>(`${url}&format=csv`, { responseType: "blob" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = href; link.download = "chipply-report.csv"; link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) { setExportError(error instanceof Error ? error.message : "CSV export failed"); }
    finally { setExporting(false); }
  }
  const report = query.data;
  return <div className="space-y-5 p-6 text-slate-100 overflow-auto">
    <header><h1 className="text-xl font-bold">Chipply report</h1><p className="mt-1 text-sm text-slate-400">Original Chipply item revenue • Current reconciled Printavo decoration and status • Never combined with Printavo dollars</p></header>
    <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5" onSubmit={e => { e.preventDefault(); setFilters({ ...draft }); setPage(0); }}>
      {[["store", "Store / event"], ["customer", "Customer"], ["status", "Printavo status"], ["vendor", "Vendor"], ["product", "Product"], ["style", "Style"]].map(([key, label]) =>
        <label key={key} className="text-xs text-slate-400">{label}<input className={inputClass} value={draft[key] ?? ""} onChange={e => change(key, e.target.value)} /></label>)}
      {[["plannedMethod", "Planned decoration", methods], ["actualMethod", "Actual decoration", [...methods, "Unallocated"]], ["methodChanged", "Method changed", ["yes", "no", "unallocated"]], ["outcome", "Match / review status", ["matched", "reviewed", "ambiguous", "quantity-mismatch", "incomplete", "unmatched", "unverified"]]].map(([key, label, options]) =>
        <label key={key as string} className="text-xs text-slate-400">{label as string}<select className={inputClass} value={draft[key as string] ?? ""} onChange={e => change(key as string, e.target.value)}><option value="">All</option>{(options as string[]).map(o => <option key={o}>{o}</option>)}</select></label>)}
      <label className="text-xs text-slate-400">Date basis<select className={inputClass} value={draft.dateBasis} onChange={e => change("dateBasis", e.target.value)}><option value="closed">Store closed date</option><option value="transaction">Order transaction date (export calendar)</option></select></label>
      {["start", "end"].map(key => <label key={key} className="text-xs text-slate-400">{key === "start" ? "From (inclusive)" : "Through (inclusive)"}<input type="date" className={inputClass} value={draft[key] ?? ""} onChange={e => change(key, e.target.value)} /></label>)}
      <button className="self-end rounded bg-emerald-600 p-2 text-sm" type="submit">Apply filters</button>
      <div className="sm:col-span-3 lg:col-span-5"><ReportDatePresets onChange={r => setDraft(prev => ({ ...prev, start: r.start, end: r.end }))} /></div>
      <button className="self-end rounded border border-slate-700 p-2 text-sm" type="button" onClick={() => { const reset = { dateBasis: "closed" }; setDraft(reset); setFilters(reset); setPage(0); }}>Reset</button>
    </form>
    {query.isFetching && <p role="status">Loading Chipply report…</p>}
    {query.error && <p role="alert" className="text-red-400">Report unavailable: {query.error.message}</p>}
    {report && !query.error && <>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">{[
        ["Item revenue", money(report.summary.itemTotalCents)], ["Quantity", report.summary.quantity],
        ["Matching lines", report.summary.lineCount], ["Distinct orders", report.summary.orderCount],
        ["Stores", report.summary.storeCount], ["Unallocated item revenue", money(report.summary.unallocatedItemTotalCents)],
      ].map(([label, value]) => <div key={label} className="rounded border border-slate-800 bg-slate-900 p-4"><div className="text-xs text-slate-400">{label}</div><div className="mt-2 text-xl font-semibold">{value}</div></div>)}</div>
      <div className="rounded border border-amber-900/60 bg-amber-950/20 p-4 text-sm text-amber-100">
        <p>Detailed financial coverage: {report.coverage.storesWithDetailedFinancials} / {report.coverage.totalStores} stores. {report.coverage.scope}.</p>
        <p>Missing dates across imported lines: {report.coverage.linesMissingTransactionDate} transaction; {report.coverage.linesMissingClosedDate} closed.</p>
        {report.coverage.missingStores.length > 0 && <details className="mt-2"><summary>Stores without detailed financials (not counted as $0)</summary><ul>{report.coverage.missingStores.map(s => <li key={s.storeId}>{s.storeName}</li>)}</ul></details>}
      </div>
      <ul className="space-y-1 text-xs text-slate-400">{report.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      <div className="flex items-center justify-between"><span className="text-sm">Filtered product lines • cents preserved in CSV</span><button className="rounded border border-slate-700 px-3 py-2 text-sm disabled:opacity-50" disabled={exporting || query.isFetching} onClick={exportCsv}>{exporting ? "Exporting…" : "Export filtered CSV"}</button></div>
      {exportError && <p role="alert" className="text-red-400">{exportError}</p>}
      <div className="overflow-x-auto rounded border border-slate-800"><table className="w-full text-left text-xs"><thead className="bg-slate-900 text-slate-400"><tr>{["Store / event", "Customer", "Order / dates", "Product", "Planned", "Actual", "Changed", "Match / review", "Printavo status / nickname", "Qty", "Item revenue"].map(h => <th className="p-3" key={h}>{h}</th>)}</tr></thead>
        <tbody>{report.lines.slice(page * 100, (page + 1) * 100).map(r => <tr key={`${r.storeId}:${r.rowOrdinal}`} className="border-t border-slate-800">
          <td className="p-3">{r.storeName}<div className="text-slate-400">{r.eventId}</div></td><td className="p-3">{r.customer ?? "Unknown"}</td>
          <td className="p-3">{r.orderNumber}<div>Transaction: {r.transactionDate ?? "Missing"}</div><div>Closed: {r.closedAt ?? "Missing"}</div></td>
          <td className="p-3">{r.vendor} {r.product}<div>{r.style} · {r.color} · {r.size}</div></td><td className="p-3">{r.plannedMethod ?? "Unknown"}</td><td className="p-3">{r.actualMethod ?? "Unallocated"}</td><td className="p-3">{r.methodChanged === null ? "Unknown" : r.methodChanged ? "Yes" : "No"}</td>
          <td className="p-3">{r.outcome}<div className="text-slate-400">{r.reason}</div></td><td className="p-3">{r.status ?? "Unallocated"}<div className="text-slate-400">{r.nickname}</div></td><td className="p-3">{r.quantity}</td><td className="p-3">{money(r.itemTotalCents)}</td>
        </tr>)}</tbody></table>{report.lines.length === 0 && <p className="p-6 text-slate-400">No imported lines match these filters. Check coverage above.</p>}</div>
      <div className="flex items-center gap-4 text-sm"><button disabled={page === 0} className="disabled:opacity-40" onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(report.lines.length / 100))}</span><button disabled={(page + 1) * 100 >= report.lines.length} className="disabled:opacity-40" onClick={() => setPage(p => p + 1)}>Next</button></div>
    </>}
  </div>;
}