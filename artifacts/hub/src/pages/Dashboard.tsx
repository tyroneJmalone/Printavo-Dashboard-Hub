import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { useStaff } from "@/components/auth/StaffGate";
import {
  useGetDashboardMetrics,
  useGetStatusBreakdown,
  getGetStatusBreakdownQueryKey,
} from "@workspace/api-client-react";
import type {
  HubDashboardMetrics,
  HubDashboardPeriod,
  HubDashboardRecentList,
} from "@workspace/api-client-react";
import { formatMoney, formatNumber } from "@/lib/format";
import { formatDashboardDate } from "@/components/dashboard/dashboardDate";
import { AlertCircle, Info, RefreshCw, FileText, Trophy, Scale, BarChart3, Target } from "lucide-react";

type PeriodKey = "today" | "wtd" | "lw" | "mtd" | "qtd" | "ytd";
type MethodKey = "all" | "print" | "embroidery" | "heat";

const PERIODS: { key: PeriodKey; label: string; long: string }[] = [
  { key: "today", label: "Today", long: "Today" },
  { key: "wtd", label: "WTD", long: "Week to date" },
  { key: "lw", label: "LW", long: "Last week (previous Mon-Sun)" },
  { key: "mtd", label: "MTD", long: "Month to date" },
  { key: "qtd", label: "QTD", long: "Quarter to date" },
  { key: "ytd", label: "YTD", long: "Year to date" },
];
const METHODS: { key: MethodKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "print", label: "Print" },
  { key: "embroidery", label: "Embroidery" },
  { key: "heat", label: "Heat" },
];

type MetricRow = {
  key: keyof Omit<HubDashboardPeriod, "start" | "end">;
  label: string;
  money?: boolean;
  note: string;
};
const METRICS: MetricRow[] = [
  { key: "totalOrders", label: "Total Orders", note: "Invoices created in period" },
  { key: "totalRevenue", label: "Total Revenue", money: true, note: "Invoice totals by Printavo creation date (not editable invoice date)" },
  { key: "itemsDecorated", label: "Items Decorated", note: "Recorded pieces on decorated invoice groups, not production completion" },
  { key: "netPayments", label: "Net Payments", money: true, note: "Payment transactions, by transaction date" },
  { key: "newCustomers", label: "New Customers", note: "Printavo customer records created in period" },
  { key: "repeatCustomers", label: "Repeat Customer", note: "Qualifying repeat orders (quotes + invoices), not distinct customers" },
];

const DASH = "—";
const fmtMoney = (v: number | null | undefined) => (v == null ? DASH : formatMoney(v));
const fmtNum = (v: number | null | undefined, d = 0) =>
  v == null ? DASH : d ? v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : formatNumber(v);

const etFmt = formatDashboardDate;
const SHORT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
function periodShort(start: string, end: string, key: PeriodKey) {
  if (key === "today") return etFmt(start, SHORT);
  if (key === "lw") return `${etFmt(start, SHORT)}-${etFmt(end, SHORT)}`;
  return `from ${etFmt(start, SHORT)}`;
}
function periodRange(start: string, end: string, key: PeriodKey) {
  return key === "today" ? etFmt(start, SHORT) : `${etFmt(start, SHORT)} through ${etFmt(end, SHORT)}`;
}

function SkeletonBlock({ h }: { h: string }) {
  return <div className={`${h} rounded-xl border border-slate-800 bg-slate-900/60 animate-pulse`} />;
}

function Segmented<T extends string>({ value, onChange, options, testPrefix }: {
  value: T; onChange: (v: T) => void; options: { key: T; label: string }[]; testPrefix: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          data-testid={`${testPrefix}-${o.key}`}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
            value === o.key ? "bg-[#10b981]/15 text-[#34d399]" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const PeriodControls = Segmented<PeriodKey>;
const MethodControls = Segmented<MethodKey>;

function PeriodMatrix({ data }: { data: HubDashboardMetrics }) {
  const p = data.periods;
  const cell = (m: MetricRow, v: number | null) => (m.money ? fmtMoney(v) : fmtNum(v));
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <BarChart3 size={17} className="text-[#10b981]" /> Performance by period
        </h2>
        <span className="text-[11px] text-slate-500">Eastern time; weeks start Monday. LW is the previous full Monday-Sunday. Quarter/year to date by calendar.</span>
      </div>

      {/* Desktop matrix */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-slate-400">
              <th className="text-left px-5 py-3 font-semibold">Metric</th>
              {PERIODS.map((pd) => (
                <th key={pd.key} className="text-right px-3 lg:px-4 py-3 font-semibold" title={periodRange(p[pd.key].start, p[pd.key].end, pd.key)}>
                  {pd.label}
                  <div className="font-normal normal-case tracking-normal text-slate-600 whitespace-nowrap">
                    {periodShort(p[pd.key].start, p[pd.key].end, pd.key)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {METRICS.map((m) => (
              <tr key={m.key} className="hover:bg-slate-800/20">
                <td className="px-5 py-3">
                  <div className="font-semibold text-slate-200">{m.label}</div>
                  <div className="text-[11px] text-slate-500">{m.note}</div>
                </td>
                {PERIODS.map((pd) => {
                  const v = p[pd.key][m.key] as number | null;
                  return (
                    <td key={pd.key} data-testid={`text-${m.key}-${pd.key}`}
                      className={`px-3 lg:px-4 py-3 text-right font-mono whitespace-nowrap tabular-nums ${pd.key === "ytd" ? "text-white font-semibold" : "text-slate-300"}`}
                      title={v == null ? "Quantity unavailable for this period" : undefined}>
                      {cell(m, v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per metric with five-period strip */}
      <div className="md:hidden divide-y divide-slate-800">
        {METRICS.map((m) => (
          <div key={m.key} className="px-4 py-3">
            <div className="font-semibold text-slate-200 text-sm">{m.label}</div>
            <div className="text-[11px] text-slate-500 mb-2">{m.note}</div>
            <div className="grid grid-cols-2 min-[420px]:grid-cols-3 gap-1">
              {PERIODS.map((pd) => (
                <div key={pd.key} className="rounded bg-slate-950/50 px-2 py-1.5 flex items-baseline justify-between gap-2 min-w-0">
                  <div className="text-[10px] uppercase text-slate-500 shrink-0">{pd.label}</div>
                  <div className="text-[12px] font-mono text-slate-200 tabular-nums break-all text-right" data-testid={`text-${m.key}-${pd.key}-m`}>
                    {cell(m, p[pd.key][m.key] as number | null)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="px-5 py-3 border-t border-slate-800 text-[11px] text-slate-500">
        A dash means the value is unavailable (not zero). {data.coverage.quantity}
      </div>
    </section>
  );
}

function AveragesPanel({ data }: { data: HubDashboardMetrics }) {
  const [period, setPeriod] = useState<PeriodKey>("mtd");
  const [method, setMethod] = useState<MethodKey>("all");
  const a = data.averages[period][method];
  const partialQty = a.orders > 0 && a.quantityKnownOrders < a.orders;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 flex flex-col">
      <div className="px-5 py-4 border-b border-slate-800 space-y-3">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <Scale size={17} className="text-[#10b981]" /> Order averages
        </h2>
        <div className="flex flex-wrap gap-2">
          <PeriodControls value={period} onChange={setPeriod} options={PERIODS} testPrefix="button-avg-period" />
          <MethodControls value={method} onChange={setMethod} options={METHODS} testPrefix="button-avg-method" />
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-slate-800">
        <div className="p-5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Average Order Value</div>
          <div className="text-2xl font-bold text-white font-mono mt-1" data-testid="text-avg-order-value">{fmtMoney(a.averageOrderValue)}</div>
          <div className="text-[11px] text-slate-500 mt-1">{formatNumber(a.orders)} orders</div>
        </div>
        <div className="p-5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Average Order Volume</div>
          <div className="text-2xl font-bold text-white font-mono mt-1" data-testid="text-avg-order-volume">
            {fmtNum(a.averageOrderVolume, 1)}
            {a.averageOrderVolume != null && <span className="text-sm text-slate-500 font-sans"> pcs/order</span>}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {a.averageOrderVolume == null
              ? a.orders === 0 ? "No orders in this slice" : "No orders with recorded quantity"
              : `Based on ${formatNumber(a.quantityKnownOrders)} orders with quantity`}
          </div>
        </div>
      </div>
      <div className="px-5 py-3 border-t border-slate-800 text-[11px] text-slate-500 space-y-1 mt-auto">
        {partialQty && <p className="text-amber-400/80">Volume uses {a.quantityKnownOrders} of {a.orders} orders; the rest lack recorded pieces.</p>}
        {method !== "all" && <p>Method filters overlap: an order with multiple decoration types counts in each, using whole-order revenue.</p>}
        <p>{PERIODS.find((x) => x.key === period)?.long}, {method === "all" ? "all decoration methods" : METHODS.find((x) => x.key === method)?.label}.</p>
      </div>
    </section>
  );
}

function RecentPanel({ data }: { data: HubDashboardMetrics }) {
  const [tab, setTab] = useState<"quotes" | "wins">("quotes");
  const [period, setPeriod] = useState<PeriodKey>("wtd");
  const act = data.activity[period];
  const pr = data.periods[period];
  const list: HubDashboardRecentList = tab === "quotes" ? act.quotesCreated : act.dealsWon;
  const plong = PERIODS.find((x) => x.key === period)?.long ?? "";
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 flex flex-col">
      <div className="px-5 py-4 border-b border-slate-800 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-bold text-white">Quotes &amp; wins</h2>
          <p className="text-[11px] text-slate-500" data-testid="text-activity-range">{plong}: {periodRange(pr.start, pr.end, period)} (Eastern)</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <PeriodControls value={period} onChange={setPeriod} options={PERIODS} testPrefix="button-activity-period" />
          <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950/60 p-0.5">
            {([
              { k: "quotes", label: "Quotes Created", n: act.quotesCreated.total, Icon: FileText },
              { k: "wins", label: "Deals Won", n: act.dealsWon.total, Icon: Trophy },
            ] as const).map(({ k, label, n, Icon }) => (
              <button key={k} type="button" data-testid={`tab-recent-${k}`} aria-pressed={tab === k} onClick={() => setTab(k)}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  tab === k ? "bg-[#10b981]/15 text-[#34d399]" : "text-slate-400 hover:text-slate-200"}`}>
                <Icon size={13} /> {label}
                <span className="font-mono rounded bg-slate-800 px-1.5 text-slate-200">{formatNumber(n)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {list.items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-14 text-center px-6">
          {tab === "quotes" ? <FileText className="text-slate-700" size={32} /> : <Trophy className="text-slate-700" size={32} />}
          <p className="text-sm text-slate-400 mt-3">{tab === "quotes" ? "No quotes created" : "No deals won observed"} in this period.</p>
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-slate-400 bg-slate-900/90 sticky top-0">
              <tr>
                <th className="text-left px-5 py-2.5 font-semibold">Order</th>
                <th className="text-left px-4 py-2.5 font-semibold">Customer</th>
                <th className="text-left px-4 py-2.5 font-semibold hidden sm:table-cell">Status</th>
                <th className="text-right px-5 py-2.5 font-semibold">{tab === "quotes" ? "Created" : "Won"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {list.items.map((it) => (
                <tr key={`${tab}-${it.orderId}`} className="hover:bg-slate-800/20" data-testid={`row-recent-${tab}-${it.orderId}`}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-200 font-mono"><PrintavoOrderLink orderId={it.orderId} visualId={it.visualId} /></div>
                    <div className="text-[11px] text-slate-500 truncate max-w-[180px]">{it.nickname || DASH}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{it.customerName || DASH}</td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="inline-flex px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">{it.statusName || "Unknown"}</span>
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-slate-400 whitespace-nowrap">
                    {etFmt(it.occurredAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-5 py-3 border-t border-slate-800 text-[11px] text-slate-500 space-y-1 mt-auto">
        <p data-testid="text-recent-count">
          Showing {formatNumber(list.items.length)} of {formatNumber(list.total)}{list.truncated ? " (list truncated; total is complete)" : ""}.
        </p>
        <p>{tab === "quotes" ? data.coverage.quotesCreated : data.coverage.dealsWon}</p>
        {tab === "quotes"
          ? <p>Quotes already converted to invoices may be missing here because their original quote timestamp is not retained.</p>
          : <p>Wins are observed status changes{data.coverage.statusHistoryFrom ? `, tracked since ${etFmt(data.coverage.statusHistoryFrom, { month: "short", day: "numeric", year: "numeric" })}` : ""}.</p>}
      </div>
    </section>
  );
}

function CloseRatePanel({ data }: { data: HubDashboardMetrics }) {
  const [period, setPeriod] = useState<PeriodKey>("mtd");
  const c = data.closeRate[period];
  const pr = data.periods[period];
  const qualifier = c.coverageComplete ? "" : "observed ";
  const big = c.quotes === 0 ? "No quotes" : c.percentage == null ? DASH : `${c.percentage.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 flex flex-col">
      <div className="px-5 py-4 border-b border-slate-800 space-y-3">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <Target size={17} className="text-[#10b981]" /> Close rate
        </h2>
        <PeriodControls value={period} onChange={setPeriod} options={PERIODS} testPrefix="button-close-period" />
      </div>
      <div className="p-5">
        <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Quotes created, later converted</div>
        <div className={`font-bold font-mono mt-1 ${c.quotes === 0 ? "text-lg text-slate-400" : "text-3xl text-white"}`} data-testid="text-close-rate"
          title={c.percentage == null && c.quotes > 0 ? "Close rate unavailable for this period" : undefined}>
          {big}
        </div>
        {c.percentage == null && c.quotes > 0 && <div className="text-[11px] text-slate-500">Unavailable, not zero</div>}
        <div className="text-xs text-slate-400 mt-2 font-mono tabular-nums" data-testid="text-close-rate-fraction">
          {formatNumber(c.converted)} of {formatNumber(c.quotes)} {qualifier}quotes converted
        </div>
        <div className="text-[11px] text-slate-500 mt-1">{periodRange(pr.start, pr.end, period)} (Eastern)</div>
      </div>
      <div className="px-5 py-3 border-t border-slate-800 text-[11px] text-slate-500 space-y-1 mt-auto">
        {!c.coverageComplete && <p className="text-amber-400/80">Partial coverage: counts are observed/known quotes only.</p>}
        {c.note && <p data-testid="text-close-rate-note" className={c.coverageComplete ? "" : "text-amber-400/80"}>{c.note}</p>}
        <p>Cohort: quotes created in the period that eventually converted to an invoice, not invoices divided by quotes in the same window.</p>
        <p>Excluded from close rate only: any status containing Merch, Contract, Dead, Archive, or Reference (case-insensitive). These are non-sales or retired records.</p>
      </div>
    </section>
  );
}

function TopStatuses() {
  const { data, isLoading, isError } = useGetStatusBreakdown(undefined, {
    query: { queryKey: getGetStatusBreakdownQueryKey(), retry: false },
  });
  const rows = data?.rows?.slice(0, 6) ?? [];
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="px-5 py-4 border-b border-slate-800">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <AlertCircle size={17} className="text-amber-500" /> Top Statuses
        </h2>
      </div>
      <div className="p-5 space-y-4">
        {isLoading ? [1, 2, 3, 4].map((i) => <div key={i} className="h-7 rounded bg-slate-800/50 animate-pulse" />)
          : isError ? <p className="text-xs text-slate-500">Status breakdown is unavailable right now.</p>
          : rows.length === 0 ? <p className="text-xs text-slate-500">No status data.</p>
          : rows.map((row) => (
            <div key={row.label} data-testid={`status-row-${row.label}`}>
              <div className="flex justify-between mb-1.5 text-sm">
                <span className="font-semibold text-slate-200 truncate pr-3">{row.label}</span>
                <span className="font-mono text-slate-400">{formatNumber(row.orders)}</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full rounded-full bg-[#10b981]" style={{ width: `${Math.max(2, (row.orders / (data?.stats.orders || 1)) * 100)}%` }} />
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

function Definitions({ defs }: { defs: Record<string, string> }) {
  const entries = Object.entries(defs);
  if (!entries.length) return null;
  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900/30 group">
      <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-300 flex items-center gap-2" data-testid="button-toggle-definitions">
        <Info size={15} className="text-slate-500" /> Metric definitions
      </summary>
      <dl className="px-5 pb-4 grid md:grid-cols-2 gap-x-8 gap-y-2">
        {entries.map(([k, v]) => (
          <div key={k} className="text-xs">
            <dt className="font-semibold text-slate-300">{k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}</dt>
            <dd className="text-slate-500">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export default function Dashboard() {
  const { role, enabledModules } = useStaff();
  const canReports = role === "admin" || enabledModules.includes("reports");
  const { data, isLoading, isError, refetch, isFetching } = useGetDashboardMetrics();

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-4 md:px-8 py-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Dashboard Overview</h1>
          <p className="text-xs text-slate-400 mt-1" data-testid="text-as-of">
            {data ? `As of ${etFmt(data.asOf, { month: "short", day: "numeric", year: "numeric" })}` : "Live metrics from Printavo"}
          </p>
        </div>
        <button type="button" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-dashboard"
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 border border-slate-800 rounded-lg px-3 py-1.5 hover:border-[#10b981]/50 hover:text-[#34d399] disabled:opacity-50">
          <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="px-4 md:px-8 py-6 md:py-8 max-w-7xl mx-auto space-y-6">
        {isLoading ? (
          <div className="space-y-6">
            <SkeletonBlock h="h-96" />
            <div className="grid lg:grid-cols-2 gap-6"><SkeletonBlock h="h-64" /><SkeletonBlock h="h-64" /></div>
          </div>
        ) : isError || !data ? (
          <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-8 text-center">
            <AlertCircle className="mx-auto text-red-400" size={28} />
            <p className="text-sm text-slate-300 mt-3">Dashboard metrics could not be loaded.</p>
            <button type="button" onClick={() => refetch()} data-testid="button-retry-dashboard"
              className="mt-4 text-xs font-semibold text-[#34d399] border border-[#10b981]/40 rounded-lg px-3 py-1.5 hover:bg-[#10b981]/10">
              Try again
            </button>
          </div>
        ) : (
          <>
            <PeriodMatrix data={data} />
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <div className="lg:col-span-3"><RecentPanel data={data} /></div>
              <div className="lg:col-span-2 space-y-6">
                <CloseRatePanel data={data} />
                <AveragesPanel data={data} />
                {canReports && <TopStatuses />}
              </div>
            </div>
            <Definitions defs={data.definitions} />
            <p className="text-[11px] text-slate-600">Orders coverage: {data.coverage.orders}</p>
          </>
        )}
      </div>
    </AppShell>
  );
}
