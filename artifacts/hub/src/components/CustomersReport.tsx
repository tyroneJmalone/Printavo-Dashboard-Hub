import { useEffect, useMemo, useState, type RefObject } from "react";
import { Link } from "wouter";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, Users } from "lucide-react";
import { useGetCustomersReport, getGetCustomersReportQueryKey, type GetCustomersReportParams, type CustomerReportRow } from "@workspace/api-client-react";
import { formatMoney, formatNumber, formatDate } from "@/lib/format";
import { ReportOutputControls, type CsvTable } from "@/components/ReportOutput";

type SortKey = "customerName" | "orders" | "revenue" | "quantity" | "avgOrderValue" | "lastInvoiceDate";
const PAGE = 100;
const inputCls = "w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5";

export type CustomerAggregateFilters = { minTotal: string; maxTotal: string; minQty: string; maxQty: string; minOrders: string; maxOrders: string };
export const emptyCustomerAggregate: CustomerAggregateFilters = { minTotal: "", maxTotal: "", minQty: "", maxQty: "", minOrders: "", maxOrders: "" };

export function CustomerAggregateControls({ value, onChange, valueLabel }: { value: CustomerAggregateFilters; onChange: (v: CustomerAggregateFilters) => void; valueLabel: string }) {
  const set = (k: keyof CustomerAggregateFilters) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const rows: [string, keyof CustomerAggregateFilters, keyof CustomerAggregateFilters, string][] = [
    [`Customer ${valueLabel.toLowerCase()} ($)`, "minTotal", "maxTotal", "customer-total"],
    ["Customer quantity", "minQty", "maxQty", "customer-qty"],
    ["Customer order count", "minOrders", "maxOrders", "customer-orders"],
  ];
  return <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3 space-y-2" data-testid="panel-customer-aggregate">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-[10px] uppercase font-bold tracking-wider text-emerald-400">Per-customer totals (applied after grouping)</h4>
      <button type="button" className="text-[11px] text-slate-400 hover:text-white" onClick={() => onChange(emptyCustomerAggregate)} data-testid="button-clear-customer-aggregate">Clear</button>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {rows.map(([label, lo, hi, id]) => <div key={id} className="space-y-1">
        <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">{label}</label>
        <div className="flex gap-2">
          <input type="number" min={0} placeholder="Min" aria-label={`${label} minimum`} value={value[lo]} onChange={set(lo)} className={inputCls} data-testid={`input-min-${id}`} />
          <input type="number" min={0} placeholder="Max" aria-label={`${label} maximum`} value={value[hi]} onChange={set(hi)} className={inputCls} data-testid={`input-max-${id}`} />
        </div>
      </div>)}
    </div>
    <p className="text-[11px] text-slate-400">Shared filters above (dates, status, category, order $/qty) choose which orders count first. These ranges then keep customers whose combined full-order totals fall inside them (inclusive). Category filters match orders containing that category; totals are the whole order, not category-only revenue.</p>
  </div>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div data-report-summary className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
    <div data-summary-label className="text-xs text-slate-400 font-medium mb-1">{label}</div>
    <div data-summary-value className="text-2xl font-bold text-white font-mono">{value}</div>
    {hint && <div className="text-[10px] text-slate-500 mt-1">{hint}</div>}
  </div>;
}

export function CustomersReport({ params, aggregate, valueLabel, filterSummary, outputRef }: {
  params: GetCustomersReportParams; aggregate: CustomerAggregateFilters; valueLabel: string; filterSummary: string[]; outputRef: RefObject<HTMLDivElement | null>;
}) {
  const n = (v: string) => (v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
  const full: GetCustomersReportParams = {
    ...params,
    minCustomerTotal: n(aggregate.minTotal), maxCustomerTotal: n(aggregate.maxTotal),
    minCustomerQty: n(aggregate.minQty), maxCustomerQty: n(aggregate.maxQty),
    minCustomerOrders: n(aggregate.minOrders), maxCustomerOrders: n(aggregate.maxOrders),
  };
  const q = useGetCustomersReport(full, { query: { queryKey: getGetCustomersReportQueryKey(full) } });
  const [term, setTerm] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "revenue", dir: -1 });
  const [page, setPage] = useState(0);
  const filterKey = JSON.stringify(full);
  useEffect(() => { setPage(0); }, [filterKey]);

  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    const list = (q.data?.customers ?? []).filter(r => !t || r.customerName.toLowerCase().includes(t));
    const val = (r: CustomerReportRow) => r[sort.key];
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return a.customerName.localeCompare(b.customerName);
      if (x === null) return 1; if (y === null) return -1;
      return (typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number)) * sort.dir;
    });
  }, [q.data, term, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const visible = rows.slice(cur * PAGE, (cur + 1) * PAGE);
  const aggregateActive = Object.values(aggregate).some(Boolean);
  const totals = {
    customers: rows.filter(r => r.customerId !== null).length,
    orders: rows.reduce((sum, r) => sum + r.orders, 0),
    revenue: rows.reduce((sum, r) => sum + r.revenue, 0),
    quantity: rows.reduce((sum, r) => sum + r.quantity, 0),
    unlinkedOrders: rows.filter(r => r.customerId === null).reduce((sum, r) => sum + r.orders, 0),
  };

  const csv = (): CsvTable => ({
    headers: ["Customer", "Customer ID", "Linked", "Orders", "Invoices", "Quotes", valueLabel, "Quantity", "Avg order value", "Categories", "First invoice", "Last invoice"],
    rows: rows.map(r => [r.customerName, r.customerId ?? "", r.customerId ? "yes" : "no (single unlinked order)", r.orders, r.invoices, r.quotes, r.revenue.toFixed(2), r.quantity, r.avgOrderValue.toFixed(2), r.categories.join("; "), r.firstInvoiceDate ?? "", r.lastInvoiceDate ?? ""]),
  });
  const th = (key: SortKey, label: string, right = true) => <th className={`px-4 py-3 ${right ? "text-right" : ""}`} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
    <button type="button" data-testid={`sort-${key}`} onClick={() => { setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "customerName" ? 1 : -1 })); setPage(0); }} className="inline-flex items-center gap-1 uppercase hover:text-white">
      {label}{sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button></th>;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
        <input value={term} onChange={e => { setTerm(e.target.value); setPage(0); }} placeholder="Filter customer names..." aria-label="Filter customer names" data-testid="input-customer-name-search" className="w-64 bg-slate-900 border border-slate-700 text-sm text-white rounded-md pl-8 pr-3 py-1.5 focus:outline-none focus:border-[#10b981]" />
      </div>
      <ReportOutputControls disabled={q.isFetching || q.isError || !q.data} targetRef={outputRef} title="Customers Report" scope={rows.length > PAGE ? `customer rows ${cur * PAGE + 1}-${Math.min((cur + 1) * PAGE, rows.length)} of ${rows.length} (current page); summaries cover all matching rows` : `all ${rows.length} matching customer rows`} filters={[...filterSummary, ...(term ? [`Customer name contains "${term}"`] : [])]} csvProvider={csv} />
    </div>
    <div ref={outputRef} className="space-y-4">
      <p className="text-xs text-slate-400" data-testid="text-customers-semantics">
        One row per linked customer. Orders without a customer link stay as separate one-order rows (never merged by name).
        {valueLabel === "Revenue" ? " Revenue is invoiced order totals." : ` ${valueLabel} includes quotes and is not realized revenue.`} Chipply store shells are excluded. Prior-year comparison is not available for Customers yet.
      </p>
      {q.isLoading ? <div className="space-y-3" aria-busy="true">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-slate-800/60" />)}</div>
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-9 animate-pulse rounded bg-slate-800/40" />)}
      </div> : q.isError ? <div role="alert" className="rounded-xl border border-red-900/50 bg-red-950/20 p-8 text-center text-sm text-red-300">
        Customers report could not load. <button className="underline" onClick={() => q.refetch()} data-testid="button-retry-customers">Retry</button>
      </div> : q.data && <>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Stat label="Customers" value={formatNumber(totals.customers)} hint={term ? "Matching names only" : undefined} />
          <Stat label="Orders" value={formatNumber(totals.orders)} hint={aggregateActive || term ? "Matching customers only" : undefined} />
          <Stat label={valueLabel} value={formatMoney(totals.revenue)} hint={aggregateActive || term ? "Matching customers only" : undefined} />
          <Stat label="Quantity" value={formatNumber(totals.quantity)} />
          <Stat label="Unlinked orders" value={formatNumber(totals.unlinkedOrders)} hint="Shown as separate rows" />
        </div>
        {q.isFetching && <p role="status" className="text-[11px] text-slate-500">Refreshing...</p>}
        {rows.length === 0 ? <div className="rounded-xl border border-dashed border-slate-700 p-12 text-center">
          <Users className="mx-auto text-slate-600" size={28} />
          <p className="mt-3 text-sm text-slate-300">No customers match.</p>
          <p className="mt-1 text-xs text-slate-500">{term ? "Clear the name filter" : aggregateActive ? "Widen the per-customer ranges" : "Widen the date range or shared filters"} to see more.</p>
        </div> : <div data-report-section="Customers" className="bg-slate-900/30 border border-slate-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm text-left whitespace-nowrap">
            <thead className="text-xs text-slate-400 bg-slate-900/80 font-semibold border-b border-slate-800 tracking-wider">
              <tr>{th("customerName", "Customer", false)}{th("orders", "Orders")}{th("revenue", valueLabel)}{th("quantity", "Qty")}{th("avgOrderValue", "Avg order")}<th className="px-4 py-3 uppercase">Categories</th><th className="px-4 py-3 uppercase">First invoice</th>{th("lastInvoiceDate", "Last invoice")}</tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {visible.map(r => <tr key={r.key} className="hover:bg-slate-800/40" data-testid={`row-customer-${r.key}`}>
                <td className="px-4 py-3 font-medium text-white">
                  {r.customerId ? <Link href={`/customers/${r.customerId}`} className="hover:text-[#10b981] underline-offset-4 hover:underline">{r.customerName}</Link> : <span>{r.customerName} <span className="ml-1 rounded border border-amber-800/60 px-1 text-[9px] uppercase text-amber-300">unlinked</span></span>}
                </td>
                <td className="px-4 py-3 text-right text-slate-300" title={`${r.invoices} invoices, ${r.quotes} quotes`}>{formatNumber(r.orders)}{r.quotes > 0 && <span className="ml-1 text-[10px] text-slate-500">({r.quotes}q)</span>}</td>
                <td className="px-4 py-3 text-right font-mono font-bold text-[#10b981]">{formatMoney(r.revenue)}</td>
                <td className="px-4 py-3 text-right font-mono text-slate-300">{formatNumber(r.quantity)}</td>
                <td className="px-4 py-3 text-right font-mono text-slate-300">{formatMoney(r.avgOrderValue)}</td>
                <td className="px-4 py-3 max-w-[260px] truncate text-xs text-slate-400" title={r.categories.join(", ")}>{r.categories.join(", ") || "—"}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-400">{formatDate(r.firstInvoiceDate)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-slate-400">{formatDate(r.lastInvoiceDate)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>}
        {rows.length > PAGE && <div data-print-exclude className="flex items-center justify-between text-sm text-slate-400">
          <span>Showing {cur * PAGE + 1}–{Math.min((cur + 1) * PAGE, rows.length)} of {formatNumber(rows.length)} customers (print shows this page; CSV includes all)</span>
          <div className="flex gap-2">
            <button aria-label="Previous page" disabled={cur === 0} onClick={() => setPage(cur - 1)} className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50"><ChevronLeft size={16} /></button>
            <button aria-label="Next page" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50"><ChevronRight size={16} /></button>
          </div>
        </div>}
      </>}
    </div>
  </div>;
}
