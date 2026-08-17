import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetEmailDealsReport,
  getGetEmailDealsReportQueryKey,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { AppShell } from "@/components/layout/AppShell";
import { ArrowLeft, TrendingUp, AlertTriangle } from "lucide-react";
import { formatMoney, formatNumber } from "@/lib/format";

/**
 * Email vs. Deals report (admin only). Correlates correspondence volume
 * with Printavo invoices won per customer over a period, plus the
 * "high email volume, no recent invoice" time-sink list. Chipply revenue
 * is never part of this — Printavo invoices only.
 */

type RangePreset = "30d" | "90d" | "6m" | "12m";
const PRESETS: { id: RangePreset; label: string; days: number }[] = [
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "6m", label: "6 months", days: 182 },
  { id: "12m", label: "12 months", days: 365 },
];

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>
  );
}

export default function EmailDealsReport() {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const [preset, setPreset] = useState<RangePreset>("90d");

  const params = useMemo(() => {
    const days = PRESETS.find((p) => p.id === preset)!.days;
    return {
      start: isoDay(new Date(Date.now() - days * 86400_000)),
      end: isoDay(new Date()),
    };
  }, [preset]);

  const { data, isLoading } = useGetEmailDealsReport(params, {
    query: { enabled: isAdmin, queryKey: getGetEmailDealsReportQueryKey(params) },
  });

  if (!isAdmin) {
    return (
      <AppShell>
        <div className="p-6 max-w-lg">
          <Card>
            <div className="text-sm text-slate-300">This report is admin-only.</div>
          </Card>
        </div>
      </AppShell>
    );
  }

  const timeSinks = data?.rows.filter((r) => r.timeSink) ?? [];

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-4 max-w-[1400px]">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/email-activity">
            <div className="text-slate-400 hover:text-slate-100 cursor-pointer">
              <ArrowLeft size={16} />
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <TrendingUp size={18} className="text-[#10b981]" />
            <h1 className="text-lg font-semibold text-white">Email vs. Deals</h1>
          </div>
          <span className="text-xs text-slate-500">Printavo invoices only — Chipply revenue excluded</span>
          <div className="flex-1" />
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              className={`text-xs px-2.5 py-1.5 rounded-md border ${
                preset === p.id
                  ? "bg-[#059669]/10 text-[#10b981] border-[#059669]/30"
                  : "text-slate-400 border-slate-700 hover:text-slate-200"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { label: "Customers emailing", value: formatNumber(data?.summary.customers ?? 0) },
            { label: "Emails", value: formatNumber(data?.summary.emails ?? 0) },
            { label: "Invoices won", value: formatNumber(data?.summary.invoicesWon ?? 0) },
            { label: "Revenue won", value: formatMoney(data?.summary.revenue ?? 0) },
            {
              label: "Emails / won invoice",
              value: data?.summary.emailsPerWonInvoice != null ? String(data.summary.emailsPerWonInvoice) : "—",
            },
          ].map((kpi) => (
            <Card key={kpi.label}>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">{kpi.label}</div>
              <div className="text-2xl font-semibold text-white mt-1">{isLoading ? "…" : kpi.value}</div>
            </Card>
          ))}
        </div>

        {/* Time sinks */}
        <Card className={timeSinks.length > 0 ? "border-amber-700/50" : ""}>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-3">
            <AlertTriangle size={15} className="text-amber-400" />
            Time sinks — 10+ emails, no invoice in period or the 90 days before it ({timeSinks.length})
          </div>
          {timeSinks.length === 0 ? (
            <div className="text-sm text-slate-500">None in this range — every heavy email thread has recent business behind it.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {timeSinks.map((r) => (
                <Link key={r.customerId} href={`/customers/${r.customerId}`}>
                  <div className="border border-amber-800/50 bg-amber-950/20 rounded-lg px-3 py-2 cursor-pointer hover:bg-amber-950/40">
                    <div className="text-sm font-semibold text-slate-200">{r.displayName}</div>
                    <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">
                      {formatNumber(r.emails)} emails · {formatNumber(r.threads)} threads · last invoice{" "}
                      {r.lastInvoiceAt ?? "never"}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        {/* Per-customer table */}
        <Card>
          <div className="text-sm font-semibold text-slate-200 mb-3">Correspondence vs. invoices won, by customer</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="py-2 pr-3">Customer</th>
                  <th className="py-2 pr-3 text-right">Threads</th>
                  <th className="py-2 pr-3 text-right">Emails</th>
                  <th className="py-2 pr-3 text-right">Invoices won</th>
                  <th className="py-2 pr-3 text-right">Revenue won</th>
                  <th className="py-2 pr-3 text-right">Emails / invoice</th>
                  <th className="py-2 pr-0 text-right">Last invoice</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((r) => (
                  <tr key={r.customerId} className="border-b border-slate-800/60">
                    <td className="py-2 pr-3">
                      <Link href={`/customers/${r.customerId}`} className="text-slate-200 font-medium hover:text-[#10b981]">
                        {r.displayName}
                      </Link>
                      {r.timeSink && (
                        <span className="ml-2 text-[10px] font-bold uppercase tracking-wide bg-amber-950/60 text-amber-300 border border-amber-800/50 rounded px-1.5 py-0.5">
                          time sink
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right text-slate-300 tabular-nums">{formatNumber(r.threads)}</td>
                    <td className="py-2 pr-3 text-right text-slate-300 tabular-nums">{formatNumber(r.emails)}</td>
                    <td className="py-2 pr-3 text-right text-slate-300 tabular-nums">{formatNumber(r.invoicesWon)}</td>
                    <td className="py-2 pr-3 text-right text-slate-200 tabular-nums">{formatMoney(r.revenue)}</td>
                    <td className="py-2 pr-3 text-right text-slate-300 tabular-nums">{r.emailsPerWonInvoice ?? "—"}</td>
                    <td className="py-2 pr-0 text-right text-slate-400 tabular-nums whitespace-nowrap">{r.lastInvoiceAt ?? "—"}</td>
                  </tr>
                ))}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-500 text-sm">
                      No customer-linked email in this range yet. Matching runs after every email sync.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
