import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useGetNicheReport,
  getGetNicheReportQueryKey,
  type GetNicheReportParams,
} from "@workspace/api-client-react";
import { formatMoney, formatNumber } from "@/lib/format";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BarChart3, Loader2, AlertTriangle } from "lucide-react";
import { Link } from "wouter";

type RangeKey = "all" | "ytd" | "last12" | "custom";

export default function NicheReport() {
  const [range, setRange] = useState<RangeKey>("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const customReady = range !== "custom" || (start.length === 10 && end.length === 10);
  const params: GetNicheReportParams = {
    range,
    ...(range === "custom" ? { start, end } : {}),
  };

  const { data, isLoading } = useGetNicheReport(params, {
    query: {
      queryKey: getGetNicheReportQueryKey(params),
      enabled: customReady,
    },
  });

  const rows = data?.rows ?? [];
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const maxRevenue = rows.length > 0 ? Math.max(...rows.map((r) => r.revenue)) : 0;
  const coverage = data?.coverage;
  const coveragePct =
    coverage && coverage.totalCustomers > 0
      ? Math.round((coverage.categorized / coverage.totalCustomers) * 100)
      : 0;

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-8 py-5">
        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <BarChart3 size={20} className="text-[#10b981]" />
          Niche Report
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Invoice revenue grouped by customer category — quotes are excluded
        </p>
      </div>

      <div className="px-8 py-4 flex flex-wrap items-center gap-3">
        <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="ytd">Year to date</SelectItem>
            <SelectItem value="last12">Last 12 months</SelectItem>
            <SelectItem value="custom">Custom range…</SelectItem>
          </SelectContent>
        </Select>
        {range === "custom" && (
          <>
            <Input
              type="date"
              className="w-40"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <span className="text-slate-500 text-sm">to</span>
            <Input
              type="date"
              className="w-40"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </>
        )}
        <span className="text-xs text-slate-500 ml-auto tabular-nums">
          Total: {formatMoney(totalRevenue)}
        </span>
      </div>

      {coverage && coveragePct < 80 && (
        <div className="mx-8 mb-4 flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-200/90">
            Only {formatNumber(coverage.categorized)} of{" "}
            {formatNumber(coverage.totalCustomers)} customers ({coveragePct}%) have a
            category, so most revenue lands in “Uncategorized”.{" "}
            <Link
              href="/customers?filter=uncategorized"
              className="underline text-amber-100 hover:text-white"
            >
              Categorize customers in the Directory
            </Link>{" "}
            — start with the biggest spenders (the default sort).
          </p>
        </div>
      )}

      <div className="px-8 pb-10">
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left font-semibold">Niche</th>
                <th className="px-4 py-3 text-left font-semibold w-[28%]"></th>
                <th className="px-4 py-3 text-right font-semibold">Revenue</th>
                <th className="px-4 py-3 text-right font-semibold">% of total</th>
                <th className="px-4 py-3 text-right font-semibold">Orders</th>
                <th className="px-4 py-3 text-right font-semibold">Customers</th>
                <th className="px-4 py-3 text-right font-semibold">Avg order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {isLoading || !customReady ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    {customReady ? (
                      <>
                        <Loader2 size={18} className="inline animate-spin mr-2" />
                        Building report…
                      </>
                    ) : (
                      "Pick a start and end date."
                    )}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    No invoices in this range.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const isUncat = r.categoryId == null;
                  return (
                    <tr
                      key={r.categoryId ?? "uncategorized"}
                      className={isUncat ? "bg-slate-900/30" : "hover:bg-slate-900/40"}
                    >
                      <td
                        className={`px-4 py-2.5 font-medium ${
                          isUncat ? "text-slate-500 italic" : "text-slate-200"
                        }`}
                      >
                        {r.categoryName}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="w-full h-2 bg-slate-800/60 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              isUncat ? "bg-slate-600" : "bg-[#10b981]"
                            }`}
                            style={{
                              width: `${maxRevenue > 0 ? Math.max(1, (r.revenue / maxRevenue) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-200">
                        {formatMoney(r.revenue)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                        {totalRevenue > 0
                          ? `${((r.revenue / totalRevenue) * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                        {formatNumber(r.orderCount)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                        {formatNumber(r.customerCount)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                        {r.orderCount > 0 ? formatMoney(r.revenue / r.orderCount) : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
