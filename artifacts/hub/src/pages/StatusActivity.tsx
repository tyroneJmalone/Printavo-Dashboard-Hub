import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetStatusActivity,
  getGetStatusActivityQueryKey,
  useGetStatusActivityOrders,
  getGetStatusActivityOrdersQueryKey,
} from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { Activity, Hourglass, Info, X } from "lucide-react";

/**
 * Status Activity — daily counts of orders entering each Printavo status
 * (from the local change feed; tracking began July 2026), plus a bottleneck
 * view: how many orders sit in each status right now and for how long.
 */

const PRESETS = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "14d", label: "14 days", days: 14 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "60d", label: "60 days", days: 60 },
  { id: "90d", label: "90 days", days: 90 },
] as const;

const STAGE_LABELS: Record<string, string> = {
  quote: "Quote",
  quote_sent: "Quote Sent",
  follow_up_1: "Follow Up 1",
  follow_up_2: "Follow Up 2",
  nurturing: "Nurturing",
  art: "Art",
  won: "Won",
  done: "Done",
  dead: "Dead",
  contract_dead_archive: "Contract Dead",
  archive: "Archive",
};

function fmtDays(d: number | null | undefined): string {
  if (d == null) return "—";
  if (d < 1) return `${Math.round(d * 24)}h`;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}

/** Emerald intensity for a heat cell, scaled to the row max. */
function heat(count: number, max: number): string {
  if (count === 0 || max === 0) return "bg-slate-800/60";
  const t = count / max;
  if (t <= 0.25) return "bg-emerald-900/60";
  if (t <= 0.5) return "bg-emerald-800/80";
  if (t <= 0.75) return "bg-emerald-600/80";
  return "bg-emerald-500";
}

function dayLabels(days: number): string[] {
  // Shop-local day keys matching the API's America/Chicago calendar window.
  // Today's Chicago date is taken via Intl; prior dates are pure calendar
  // arithmetic in UTC so DST transitions can't skip or duplicate a day.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y!, m! - 1, d! - i));
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** Drill-down modal: the invoices behind a status (arrivals or currently-in). */
function StatusOrdersModal({
  statusName,
  mode,
  days,
  onClose,
}: {
  statusName: string;
  mode: "arrivals" | "current";
  days: number;
  onClose: () => void;
}) {
  const params = { status: statusName, mode, days };
  const { data, isLoading } = useGetStatusActivityOrders(params, {
    query: { queryKey: getGetStatusActivityOrdersQueryKey(params) },
  });
  const orders = data?.orders ?? [];
  const totalValue = orders.reduce((s, o) => s + o.total, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-700 p-4">
          <div>
            <h3 className="text-sm font-semibold text-white">{statusName}</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {mode === "arrivals"
                ? `Orders that entered this status in the last ${days} days`
                : "Orders currently in this status"}
              {orders.length > 0 && ` — ${orders.length} order${orders.length === 1 ? "" : "s"}, ${fmtMoney(totalValue)}`}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {isLoading ? (
            <div className="text-sm text-slate-400 py-6 text-center">Loading…</div>
          ) : orders.length === 0 ? (
            <div className="text-sm text-slate-400 py-6 text-center">No orders found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                  <th className="py-2 pr-3 font-normal">Order</th>
                  <th className="py-2 px-3 font-normal">Customer</th>
                  <th className="py-2 px-3 font-normal">Nickname</th>
                  <th className="py-2 px-3 font-normal text-right">Total</th>
                  <th className="py-2 pl-3 font-normal text-right">
                    {mode === "arrivals" ? "Entered" : "Since"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.printavoId} className="border-b border-slate-800/60">
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">
                      <PrintavoOrderLink orderId={o.printavoId} visualId={o.visualId} className="text-slate-200" />
                      {mode === "arrivals" && !o.stillInStatus && (
                        <span className="ml-1.5 text-[10px] text-slate-500" title="Has since moved to another status">
                          moved on
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-slate-200 max-w-[180px] truncate">
                      {o.customerId ? (
                        <Link
                          href={`/customers/${o.customerId}`}
                          className="hover:text-[#10b981] hover:underline underline-offset-2"
                        >
                          {o.customerName ?? "(no name)"}
                        </Link>
                      ) : (
                        (o.customerName ?? "—")
                      )}
                    </td>
                    <td className="py-2 px-3 text-slate-400 max-w-[180px] truncate" title={o.nickname ?? undefined}>
                      {o.nickname || "—"}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-300">{fmtMoney(o.total)}</td>
                    <td className="py-2 pl-3 text-right text-slate-400 whitespace-nowrap text-xs">
                      {o.at
                        ? new Date(o.at).toLocaleDateString("en-US", {
                            timeZone: "America/Chicago",
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StatusActivity() {
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("30d");
  const [drill, setDrill] = useState<{ statusName: string; mode: "arrivals" | "current" } | null>(null);
  const days = PRESETS.find((p) => p.id === preset)!.days;
  const params = { days };
  const { data, isLoading } = useGetStatusActivity(params, {
    query: { queryKey: getGetStatusActivityQueryKey(params) },
  });

  const cols = useMemo(() => dayLabels(days), [days]);
  const statuses = data?.statuses ?? [];
  const active = statuses.filter((s) => s.totalArrivals > 0);
  const bottlenecks = useMemo(
    () =>
      [...statuses]
        .filter((s) => s.currentCount > 0)
        .sort((a, b) => (b.medianDwellDays ?? 0) - (a.medianDwellDays ?? 0)),
    [statuses],
  );

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white flex items-center gap-2">
              <Activity className="h-5 w-5 text-emerald-400" /> Status Activity
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              How many orders hit each status per day, and where orders are piling up.
            </p>
          </div>
          <div className="flex gap-1 rounded-lg bg-slate-800 p-1">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPreset(p.id)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  preset === p.id ? "bg-emerald-600 text-white" : "text-slate-300 hover:text-white"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {data?.firstTrackedAt && (
          <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs text-slate-400">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Status changes have been tracked since{" "}
              {new Date(data.firstTrackedAt).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })}
              . Timestamps reflect when the change was observed by the sync, so same-day timing is approximate.
            </span>
          </div>
        )}

        {/* Daily arrivals heat grid */}
        <section className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold text-white mb-3">Orders entering each status per day</h2>
          {isLoading ? (
            <div className="text-sm text-slate-400 py-8 text-center">Loading…</div>
          ) : active.length === 0 ? (
            <div className="text-sm text-slate-400 py-8 text-center">No status changes recorded in this window.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs border-separate" style={{ borderSpacing: "2px" }}>
                <thead>
                  <tr>
                    <th className="text-left text-slate-400 font-normal pr-2 sticky left-0 bg-slate-900">Status</th>
                    <th className="text-right text-slate-400 font-normal px-2">Total</th>
                    {cols.map((d) => (
                      <th key={d} className="text-slate-500 font-normal min-w-[22px] align-bottom">
                        <div className="[writing-mode:vertical-rl] rotate-180 mx-auto whitespace-nowrap">
                          {d.slice(5).replace("-", "/")}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {active.map((s) => {
                    const byDay = new Map(s.daily.map((d) => [d.day, d.count]));
                    const rowMax = Math.max(...s.daily.map((d) => d.count), 0);
                    return (
                      <tr key={s.statusName}>
                        <td className="pr-2 whitespace-nowrap max-w-[260px] truncate sticky left-0 bg-slate-900" title={s.statusName}>
                          <button
                            onClick={() => setDrill({ statusName: s.statusName, mode: "arrivals" })}
                            className="text-slate-200 hover:text-[#10b981] hover:underline underline-offset-2"
                          >
                            {s.statusName}
                          </button>
                          {s.stageId && (
                            <span className="ml-1.5 text-[10px] text-slate-500">{STAGE_LABELS[s.stageId] ?? s.stageId}</span>
                          )}
                        </td>
                        <td className="px-2 text-right text-slate-300 font-medium">{s.totalArrivals}</td>
                        {cols.map((d) => {
                          const c = byDay.get(d) ?? 0;
                          return (
                            <td key={d}>
                              <div
                                className={`h-[18px] w-[22px] rounded-sm ${heat(c, rowMax)} flex items-center justify-center`}
                                title={`${d}: ${c}`}
                              >
                                {c > 0 && <span className="text-[9px] text-white/90">{c}</span>}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Bottlenecks */}
        <section className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
            <Hourglass className="h-4 w-4 text-amber-400" /> Where orders are sitting right now
          </h2>
          <p className="text-xs text-slate-400 mb-3">
            All orders grouped by their current status (finished and dead ones included), with how long orders have
            typically been there — based on observed status changes. Long median dwell + high count in a working
            status = likely bottleneck.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                  <th className="py-2 pr-3 font-normal">Status</th>
                  <th className="py-2 px-3 font-normal">Stage</th>
                  <th className="py-2 px-3 font-normal text-right">Orders now</th>
                  <th className="py-2 px-3 font-normal text-right">Median time in status</th>
                  <th className="py-2 pl-3 font-normal text-right">Longest</th>
                </tr>
              </thead>
              <tbody>
                {bottlenecks.map((s) => (
                  <tr key={s.statusName} className="border-b border-slate-800/60">
                    <td className="py-2 pr-3 max-w-[300px] truncate" title={s.statusName}>
                      <button
                        onClick={() => setDrill({ statusName: s.statusName, mode: "current" })}
                        className="text-slate-200 hover:text-[#10b981] hover:underline underline-offset-2"
                      >
                        {s.statusName}
                      </button>
                    </td>
                    <td className="py-2 px-3 text-slate-400 text-xs">{s.stageId ? STAGE_LABELS[s.stageId] ?? s.stageId : "—"}</td>
                    <td className="py-2 px-3 text-right text-slate-200 font-medium">{s.currentCount}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{fmtDays(s.medianDwellDays)}</td>
                    <td className="py-2 pl-3 text-right text-slate-400">{fmtDays(s.maxDwellDays)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {drill && (
          <StatusOrdersModal
            statusName={drill.statusName}
            mode={drill.mode}
            days={days}
            onClose={() => setDrill(null)}
          />
        )}
      </div>
    </AppShell>
  );
}
