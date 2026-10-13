import { useQuery } from "@tanstack/react-query";
import {
  getOrdersReport, getGetOrdersReportQueryKey,
  getStatusBreakdown, getGetStatusBreakdownQueryKey,
  getPricingMatrixBreakdown, getGetPricingMatrixBreakdownQueryKey,
  getImprintsByTier, getGetImprintsByTierQueryKey,
  getOrderQuantityBreakdown, getGetOrderQuantityBreakdownQueryKey,
  getStyleNumberBreakdown, getGetStyleNumberBreakdownQueryKey,
  getBrandBreakdown, getGetBrandBreakdownQueryKey,
  getColorBreakdown, getGetColorBreakdownQueryKey,
  getCategoryBreakdown, getGetCategoryBreakdownQueryKey,
  type GetOrdersReportParams,
} from "@workspace/api-client-react";
import { comparisonChange, joinComparisonRows, type ComparisonRange } from "@/lib/report-comparison";
import { reportShare } from "@/lib/report-share";
import { formatMoney, formatNumber } from "@/lib/format";
import { AlertTriangle, RotateCw } from "lucide-react";

export type ComparableTab = "status" | "pricing" | "tier" | "quantity" | "style" | "brand" | "color" | "category";
type Metric = "orders" | "quantity" | "revenue";
type BreakdownLike = { stats: { orders: number; quantity: number; revenue: number }; rows: { label: string; orders: number; quantity: number; revenue: number }[] };

const ENDPOINTS: Record<ComparableTab, { fetch: (p: GetOrdersReportParams, o: { signal?: AbortSignal }) => Promise<BreakdownLike>; key: (p: GetOrdersReportParams) => readonly unknown[]; label: string }> = {
  status: { fetch: (p, o) => getStatusBreakdown(p, o), key: getGetStatusBreakdownQueryKey, label: "Status" },
  pricing: { fetch: (p, o) => getPricingMatrixBreakdown(p, o), key: getGetPricingMatrixBreakdownQueryKey, label: "Pricing matrix" },
  tier: { fetch: (p, o) => getImprintsByTier(p, o), key: getGetImprintsByTierQueryKey, label: "Imprint tier" },
  quantity: { fetch: (p, o) => getOrderQuantityBreakdown(p, o), key: getGetOrderQuantityBreakdownQueryKey, label: "Quantity range" },
  style: { fetch: (p, o) => getStyleNumberBreakdown(p, o), key: getGetStyleNumberBreakdownQueryKey, label: "Style" },
  brand: { fetch: (p, o) => getBrandBreakdown(p, o), key: getGetBrandBreakdownQueryKey, label: "Brand" },
  color: { fetch: (p, o) => getColorBreakdown(p, o), key: getGetColorBreakdownQueryKey, label: "Color" },
  category: { fetch: (p, o) => getCategoryBreakdown(p, o), key: getGetCategoryBreakdownQueryKey, label: "Category" },
};

const fmt = (m: Metric, v: number) => (m === "revenue" ? formatMoney(v) : formatNumber(v));
const signed = (m: Metric, v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(m, Math.abs(v));
export const rangeLabel = (r: ComparisonRange) => `${r.start} – ${r.end}`;

function Delta({ metric, current, previous }: { metric: Metric; current: number; previous: number }) {
  const c = comparisonChange(current, previous);
  return <>
    <td className="px-3 py-2.5 text-right font-mono text-slate-200" data-testid={`delta-${metric}`}>{signed(metric, c.difference)}</td>
    <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-400">
      {c.percent === null ? <span className="italic text-slate-500">No prior-year baseline</span> : `${c.percent > 0 ? "+" : c.percent < 0 ? "−" : ""}${Math.abs(c.percent).toFixed(1)}%`}
    </td>
  </>;
}

function Skeleton() {
  return <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading comparison">
    {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-slate-800/60" style={{ opacity: 1 - i * 0.15 }} />)}
  </div>;
}

function Failure({ onRetry }: { onRetry: () => void }) {
  return <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-300">
    <span className="flex items-center gap-2"><AlertTriangle size={16} /> Comparison could not load. No partial figures are shown.</span>
    <button type="button" onClick={onRetry} className="flex items-center gap-1 rounded border border-red-800 px-3 py-1.5 text-xs hover:bg-red-900/30" data-testid="button-retry-comparison"><RotateCw size={12} /> Retry</button>
  </div>;
}

function Legend({ current, previous }: { current: ComparisonRange; previous: ComparisonRange }) {
  return <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400">
    <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#10b981]" />Current <span className="font-mono text-slate-200">{rangeLabel(current)}</span></span>
    <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-slate-500" />Prior year <span className="font-mono text-slate-200">{rangeLabel(previous)}</span></span>
  </div>;
}

const HEAD = "px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-semibold";

export function SummaryComparison({ currentParams, previousParams, currentRange, previousRange }: { currentParams: GetOrdersReportParams; previousParams: GetOrdersReportParams; currentRange: ComparisonRange; previousRange: ComparisonRange }) {
  const cp = { ...currentParams, limit: 1, offset: 0 }, pp = { ...previousParams, limit: 1, offset: 0 };
  const cur = useQuery({ queryKey: getGetOrdersReportQueryKey(cp), queryFn: ({ signal }) => getOrdersReport(cp, { signal }) });
  const prev = useQuery({ queryKey: getGetOrdersReportQueryKey(pp), queryFn: ({ signal }) => getOrdersReport(pp, { signal }) });
  const loading = cur.isPending || prev.isPending || (cur.isFetching && cur.isPlaceholderData) || (prev.isFetching && prev.isPlaceholderData);
  return <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4" data-testid="section-summary-comparison">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-white">Compared with last year</h2>
      <Legend current={currentRange} previous={previousRange} />
    </div>
    {cur.isError || prev.isError ? <Failure onRetry={() => { cur.refetch(); prev.refetch(); }} /> : loading || !cur.data || !prev.data ? <Skeleton /> : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] whitespace-nowrap text-sm">
          <thead className="border-b border-slate-800"><tr>
            <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500">Metric</th>
            <th className={HEAD}>Current</th><th className={HEAD}>Prior year</th><th className={HEAD}>Change</th><th className={HEAD}>% change</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/70">
            {([["revenue", "Revenue"], ["orders", "Orders"], ["quantity", "Quantity"]] as const).map(([m, label]) => (
              <tr key={m}>
                <td className="px-3 py-2.5 text-slate-300">{label}</td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold text-[#10b981]">{fmt(m, cur.data.stats[m])}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-400">{fmt(m, prev.data.stats[m])}</td>
                <Delta metric={m} current={cur.data.stats[m]} previous={prev.data.stats[m]} />
              </tr>
            ))}
          </tbody>
        </table>
        {cur.data.stats.orders === 0 && prev.data.stats.orders === 0 && <p className="px-3 pt-3 text-xs text-slate-500">No orders match these filters in either period.</p>}
      </div>
    )}
    <p className="text-xs text-slate-400">Both periods use the same filters and date basis. Status filters use current recorded statuses, not historical status snapshots.</p>
  </section>;
}

function Badge({ presence }: { presence: string }) {
  if (presence === "new") return <span className="ml-2 rounded border border-emerald-800/60 bg-emerald-950/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300">New activity</span>;
  if (presence === "previous-only") return <span className="ml-2 rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">No activity this period</span>;
  return null;
}

function shareCell(value: number, total: number) { return `${reportShare(value, total).toFixed(1)}%`; }
function pp(curShare: number, prevShare: number) { const d = curShare - prevShare; return `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toFixed(1)} pp`; }

export function BreakdownComparison({ tab, currentParams, previousParams, currentRange, previousRange }: { tab: ComparableTab; currentParams: GetOrdersReportParams; previousParams: GetOrdersReportParams; currentRange: ComparisonRange; previousRange: ComparisonRange }) {
  const ep = ENDPOINTS[tab];
  const cur = useQuery({ queryKey: ep.key(currentParams), queryFn: ({ signal }) => ep.fetch(currentParams, { signal }) });
  const prev = useQuery({ queryKey: ep.key(previousParams), queryFn: ({ signal }) => ep.fetch(previousParams, { signal }) });
  const ready = cur.data && prev.data && !cur.isPending && !prev.isPending && !cur.isPlaceholderData && !prev.isPlaceholderData;
  const rows = ready ? joinComparisonRows(cur.data!.rows, prev.data!.rows).sort((a, b) => b.current.revenue - a.current.revenue || b.previous.revenue - a.previous.revenue) : [];
  const metrics: [Metric, string][] = [["revenue", "Revenue"], ["orders", "Orders"], ["quantity", "Quantity"]];
  return <section className="space-y-3" data-testid={`section-breakdown-comparison-${tab}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-white">{ep.label} compared with last year</h2>
      <Legend current={currentRange} previous={previousRange} />
    </div>
    <p className="text-xs leading-relaxed text-slate-400">
      Groups use each order's <span className="text-slate-200">currently recorded</span> values (for example, today's status), not a snapshot of what they were a year ago.
      Orders can belong to several groups, so counts overlap and shares can exceed 100%; quantity and revenue keep each row's existing attribution.
      Shares use each period's full filtered totals; share changes are in percentage points (pp). Changes are shown neutrally.
    </p>
    {cur.isError || prev.isError ? <Failure onRetry={() => { cur.refetch(); prev.refetch(); }} /> : !ready ? <div className="rounded-xl border border-slate-800"><Skeleton /></div> : rows.length === 0 ? (
      <div className="rounded-xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-500">No groups found in either period for these filters.</div>
    ) : (
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
        <table className="w-full min-w-[1500px] whitespace-nowrap text-sm">
          <thead className="bg-slate-900/80">
            <tr className="border-b border-slate-800">
              <th rowSpan={2} className="sticky left-0 z-10 bg-slate-900 px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500">Label</th>
              {metrics.map(([m, l]) => <th key={m} colSpan={6} className="border-l border-slate-800 px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wider text-slate-300">{l}</th>)}
            </tr>
            <tr className="border-b border-slate-800">
              {metrics.map(([m]) => ["Current", "Prior", "Change", "% chg", "Share now / prior", "Share chg"].map((h, i) => <th key={m + h} className={`${HEAD} ${i === 0 ? "border-l border-slate-800" : ""}`}>{h}</th>))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {rows.map(r => (
              <tr key={r.label} className="hover:bg-slate-800/30" data-testid={`row-comparison-${r.label}`}>
                <td className="sticky left-0 z-10 bg-[#0b1222] px-3 py-2.5 font-medium text-white">{r.label}<Badge presence={r.presence} /></td>
                {metrics.map(([m]) => {
                  const cs = reportShare(r.current[m], cur.data!.stats[m]), ps = reportShare(r.previous[m], prev.data!.stats[m]);
                  return [
                    <td key={m + "c"} className="border-l border-slate-800 px-3 py-2.5 text-right font-mono text-[#10b981]">{fmt(m, r.current[m])}</td>,
                    <td key={m + "p"} className="px-3 py-2.5 text-right font-mono text-slate-400">{fmt(m, r.previous[m])}</td>,
                    <Delta key={m + "d"} metric={m} current={r.current[m]} previous={r.previous[m]} />,
                    <td key={m + "s"} className="px-3 py-2.5 text-right font-mono text-xs text-slate-400">{shareCell(r.current[m], cur.data!.stats[m])} / {shareCell(r.previous[m], prev.data!.stats[m])}</td>,
                    <td key={m + "sd"} className="px-3 py-2.5 text-right font-mono text-xs text-slate-300">{pp(cs, ps)}</td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-slate-700 bg-slate-900 font-semibold">
            <tr>
              <th className="sticky left-0 bg-slate-900 px-3 py-3 text-left">Full filtered totals</th>
              {metrics.map(([m]) => [
                <td key={`${m}-total-current`} className="px-3 py-3 text-right font-mono">{fmt(m, cur.data!.stats[m])}</td>,
                <td key={`${m}-total-prior`} className="px-3 py-3 text-right font-mono">{fmt(m, prev.data!.stats[m])}</td>,
                <Delta key={`${m}-total-delta`} metric={m} current={cur.data!.stats[m]} previous={prev.data!.stats[m]} />,
                <td key={`${m}-total-share`} colSpan={2} className="px-3 py-3 text-right text-xs text-slate-400">Not a sum of overlapping rows</td>,
              ])}
            </tr>
          </tfoot>
        </table>
      </div>
    )}
  </section>;
}
