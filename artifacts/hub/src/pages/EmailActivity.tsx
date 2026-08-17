import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetEmailActivityStatus,
  getGetEmailActivityStatusQueryKey,
  useGetEmailActivityStats,
  getGetEmailActivityStatsQueryKey,
  useGetEmailResponseTimes,
  getGetEmailResponseTimesQueryKey,
  useGetEmailUnansweredThreads,
  getGetEmailUnansweredThreadsQueryKey,
  useGetEmailHeatmap,
  getGetEmailHeatmapQueryKey,
  useGetEmailFilteredBucket,
  getGetEmailFilteredBucketQueryKey,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { AppShell } from "@/components/layout/AppShell";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { Mail, Clock, Flame, Filter, AlertTriangle, Settings2 } from "lucide-react";

/**
 * Email Activity dashboard (admin only). Sent/received/thread stats per
 * person, response times, unanswered threads, hot-zone heatmap, and the
 * filtered bucket for spot-checking the bulk-mail exclusion system.
 */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const REASON_LABELS: Record<string, string> = {
  "rule-address": "Excluded address",
  "rule-domain": "Excluded domain",
  "list-unsubscribe": "List-Unsubscribe header",
  "no-reply": "No-reply sender",
  "gmail-category": "Gmail category (promo/social/…)",
  "auto-submitted": "Auto-submitted / bulk precedence",
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDur(secs: number | null | undefined): string {
  if (secs == null) return "—";
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

function personLabel(p: { displayName?: string | null; email?: string | null }): string {
  return p.displayName || p.email?.split("@")[0] || "—";
}

const CHART_COLORS = ["#10b981", "#38bdf8", "#f59e0b", "#a78bfa", "#f472b6", "#facc15"];

type RangePreset = "7d" | "30d" | "90d" | "12m";
const PRESETS: { id: RangePreset; label: string; days: number }[] = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "12m", label: "12 months", days: 365 },
];

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<any>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-3">
      <Icon size={15} className="text-[#10b981]" />
      {children}
    </div>
  );
}

function Heatmap({ cells, mode }: { cells: { dow: number; hour: number; sent: number; received: number }[]; mode: "all" | "sent" | "received" }) {
  const grid = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const c of cells) {
      const v = mode === "sent" ? c.sent : mode === "received" ? c.received : c.sent + c.received;
      g[c.dow]![c.hour] = v;
    }
    return g;
  }, [cells, mode]);
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="grid" style={{ gridTemplateColumns: "36px repeat(24, 1fr)", gap: 2 }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-[9px] text-slate-500 text-center">
              {h % 3 === 0 ? (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`) : ""}
            </div>
          ))}
          {grid.map((row, dow) => (
            <>
              <div key={`d${dow}`} className="text-[10px] text-slate-400 pr-1 flex items-center">
                {DOW[dow]}
              </div>
              {row.map((v, h) => {
                const t = v / max;
                return (
                  <div
                    key={`${dow}-${h}`}
                    title={`${DOW[dow]} ${h}:00 — ${v} messages`}
                    className="h-5 rounded-[3px]"
                    style={{
                      backgroundColor: v === 0 ? "#1e293b" : `rgba(16,185,129,${0.15 + t * 0.85})`,
                    }}
                  />
                );
              })}
            </>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function EmailActivity() {
  const { role } = useStaff();
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [granularity, setGranularity] = useState<"daily" | "weekly" | "monthly">("daily");
  const [mailboxId, setMailboxId] = useState<string>("");
  const [heatMode, setHeatMode] = useState<"all" | "sent" | "received">("all");

  const { start, end } = useMemo(() => {
    const days = PRESETS.find((p) => p.id === preset)!.days;
    const endD = new Date();
    const startD = new Date(Date.now() - days * 86400_000);
    return { start: isoDay(startD), end: isoDay(endD) };
  }, [preset]);

  const isAdmin = role === "admin";
  const common = { start, end, ...(mailboxId ? { mailboxId } : {}) };
  const statsParams = { granularity, ...common };
  const unansweredParams = mailboxId ? { mailboxId } : {};
  const { data: status } = useGetEmailActivityStatus({
    query: { enabled: isAdmin, queryKey: getGetEmailActivityStatusQueryKey() },
  });
  const { data: stats, isLoading } = useGetEmailActivityStats(statsParams, {
    query: { enabled: isAdmin, queryKey: getGetEmailActivityStatsQueryKey(statsParams) },
  });
  const { data: responseTimes } = useGetEmailResponseTimes(common, {
    query: { enabled: isAdmin, queryKey: getGetEmailResponseTimesQueryKey(common) },
  });
  const { data: unanswered } = useGetEmailUnansweredThreads(unansweredParams, {
    query: { enabled: isAdmin, queryKey: getGetEmailUnansweredThreadsQueryKey(unansweredParams) },
  });
  const { data: heatmap } = useGetEmailHeatmap(common, {
    query: { enabled: isAdmin, queryKey: getGetEmailHeatmapQueryKey(common) },
  });
  const { data: filtered } = useGetEmailFilteredBucket(common, {
    query: { enabled: isAdmin, queryKey: getGetEmailFilteredBucketQueryKey(common) },
  });

  const series = useMemo(() => {
    if (!stats) return [];
    const byBucket = new Map<string, { bucket: string; sent: number; received: number }>();
    for (const p of stats.series) {
      const row = byBucket.get(p.bucket) ?? { bucket: p.bucket, sent: 0, received: 0 };
      row.sent += p.sent;
      row.received += p.received;
      byBucket.set(p.bucket, row);
    }
    return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [stats]);

  if (!isAdmin) {
    return (
      <AppShell>
        <div className="p-6 max-w-lg">
          <Card>
            <div className="text-sm text-slate-300">Email Activity is admin-only — it contains staff performance data.</div>
          </Card>
        </div>
      </AppShell>
    );
  }

  const needsSetup = status && (!status.credentialsConfigured || status.mailboxes.length === 0);

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-4 max-w-[1400px]">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Mail size={18} className="text-[#10b981]" />
            <h1 className="text-lg font-semibold text-white">Email Activity</h1>
          </div>
          <div className="flex-1" />
          <Link href="/email-activity/settings">
            <div className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 border border-slate-700 rounded-md px-2.5 py-1.5 cursor-pointer">
              <Settings2 size={13} /> Mailboxes & exclusions
            </div>
          </Link>
        </div>

        {needsSetup && (
          <Card className="border-amber-700/50">
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-slate-300">
                {status?.credentialsConfigured
                  ? "No mailboxes are tracked yet."
                  : "Google Workspace credentials aren't configured yet."}{" "}
                <Link href="/email-activity/settings" className="text-[#10b981] hover:underline">
                  Open the setup screen
                </Link>{" "}
                for the click-by-click walkthrough.
              </div>
            </div>
          </Card>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="w-px h-5 bg-slate-800 mx-1 hidden sm:block" />
          {(["daily", "weekly", "monthly"] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={`text-xs px-2.5 py-1.5 rounded-md border capitalize ${
                granularity === g
                  ? "bg-[#059669]/10 text-[#10b981] border-[#059669]/30"
                  : "text-slate-400 border-slate-700 hover:text-slate-200"
              }`}
            >
              {g}
            </button>
          ))}
          <div className="w-px h-5 bg-slate-800 mx-1 hidden sm:block" />
          <select
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
            className="text-xs bg-[#1e293b] border border-slate-700 rounded-md px-2 py-1.5 text-slate-200"
          >
            <option value="">Whole team</option>
            {status?.mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName || m.email}
              </option>
            ))}
          </select>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { label: "Sent", value: stats?.team.sent },
            { label: "Received", value: stats?.team.received },
            { label: "Threads", value: stats?.team.threads },
            { label: "Median response", value: fmtDur(responseTimes?.team.medianSecs), raw: true },
            { label: "Filtered out", value: filtered?.total },
          ].map((kpi) => (
            <Card key={kpi.label}>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">{kpi.label}</div>
              <div className="text-2xl font-semibold text-white mt-1">
                {isLoading ? "…" : kpi.raw ? kpi.value : (kpi.value ?? 0).toLocaleString()}
              </div>
            </Card>
          ))}
        </div>

        {/* Trend */}
        <Card>
          <SectionTitle icon={Mail}>Volume trend ({granularity})</SectionTitle>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tick={{ fill: "#64748b", fontSize: 10 }} />
                <YAxis tick={{ fill: "#64748b", fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#94a3b8" }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="sent" stroke="#10b981" strokeWidth={2} dot={false} name="Sent" />
                <Line type="monotone" dataKey="received" stroke="#38bdf8" strokeWidth={2} dot={false} name="Received" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Per-person table */}
        <Card>
          <SectionTitle icon={Mail}>Per person</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="py-2 pr-3">Person</th>
                  <th className="py-2 pr-3 text-right">Sent</th>
                  <th className="py-2 pr-3 text-right">Received</th>
                  <th className="py-2 pr-3 text-right">Threads</th>
                  <th className="py-2 pr-3 text-right">Avg thread depth</th>
                  <th className="py-2 pr-3 text-right">Median reply</th>
                  <th className="py-2 pr-0 text-right">Filtered</th>
                </tr>
              </thead>
              <tbody>
                {stats?.people.map((p, i) => {
                  const rt = responseTimes?.people.find((r) => r.mailboxId === p.mailboxId);
                  return (
                    <tr key={p.mailboxId ?? i} className="border-b border-slate-800/60">
                      <td className="py-2 pr-3 text-slate-200 font-medium">
                        <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                        {personLabel(p)}
                      </td>
                      <td className="py-2 pr-3 text-right text-slate-300">{p.sent.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{p.received.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{p.threads.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{p.avgThreadDepth ?? "—"}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{fmtDur(rt?.medianSecs)}</td>
                      <td className="py-2 pr-0 text-right text-slate-500">{p.filtered.toLocaleString()}</td>
                    </tr>
                  );
                })}
                {stats && stats.people.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-500 text-sm">
                      No counted email in this range yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="grid lg:grid-cols-2 gap-4">
          {/* Response times */}
          <Card>
            <SectionTitle icon={Clock}>Response time (inbound → first reply)</SectionTitle>
            <div className="space-y-3">
              {responseTimes?.people.map((p) => {
                const total = p.distribution.reduce((s, v) => s + v, 0) || 1;
                const labels = ["<15m", "15m–1h", "1–4h", "4–24h", ">24h"];
                const colors = ["#10b981", "#34d399", "#facc15", "#fb923c", "#f87171"];
                return (
                  <div key={p.mailboxId ?? "team"}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-slate-200 font-medium">{personLabel(p)}</span>
                      <span className="text-slate-400">
                        median {fmtDur(p.medianSecs)} · p90 {fmtDur(p.p90Secs)} · {p.repliedThreads} threads
                      </span>
                    </div>
                    <div className="flex h-3 rounded overflow-hidden bg-slate-800">
                      {p.distribution.map((v, i) => (
                        <div
                          key={i}
                          title={`${labels[i]}: ${v}`}
                          style={{ width: `${(v / total) * 100}%`, backgroundColor: colors[i] }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
              {responseTimes && responseTimes.people.length === 0 && (
                <div className="text-sm text-slate-500">No replied threads in this range.</div>
              )}
              <div className="flex gap-3 text-[10px] text-slate-500 pt-1">
                {["<15m", "15m–1h", "1–4h", "4–24h", ">24h"].map((l, i) => (
                  <span key={l} className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: ["#10b981", "#34d399", "#facc15", "#fb923c", "#f87171"][i] }} />
                    {l}
                  </span>
                ))}
              </div>
            </div>
          </Card>

          {/* Unanswered */}
          <Card>
            <SectionTitle icon={AlertTriangle}>
              Unanswered past {unanswered?.thresholdHours ?? "…"}h ({unanswered?.threads.length ?? 0})
            </SectionTitle>
            <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar pr-1">
              {unanswered?.threads.map((t) => (
                <div key={`${t.mailboxId}-${t.gmailThreadId}`} className="border border-slate-800 rounded-md px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-slate-200 truncate font-medium">{t.subject || "(no subject)"}</div>
                    <div className="text-[10px] text-amber-400 whitespace-nowrap">{fmtDur(t.ageHours * 3600)} old</div>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                    {t.counterpart} → {t.email?.split("@")[0]} · {t.messageCount} msg{t.messageCount === 1 ? "" : "s"}
                  </div>
                </div>
              ))}
              {unanswered && unanswered.threads.length === 0 && (
                <div className="text-sm text-slate-500">Nothing waiting — inbox zero on replies.</div>
              )}
            </div>
          </Card>
        </div>

        {/* Heatmap */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionTitle icon={Flame}>Hot zones (day × hour, shop time)</SectionTitle>
            <div className="flex gap-1">
              {(["all", "sent", "received"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setHeatMode(m)}
                  className={`text-[11px] px-2 py-1 rounded border capitalize ${
                    heatMode === m
                      ? "bg-[#059669]/10 text-[#10b981] border-[#059669]/30"
                      : "text-slate-400 border-slate-700"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <Heatmap cells={heatmap?.cells ?? []} mode={heatMode} />
        </Card>

        {/* Filtered bucket */}
        <Card>
          <SectionTitle icon={Filter}>Filtered bucket ({filtered?.total ?? 0} in range)</SectionTitle>
          <div className="grid lg:grid-cols-[260px,1fr] gap-4">
            <div className="space-y-1.5">
              {filtered?.breakdown.map((b) => (
                <div key={b.reason} className="flex items-center justify-between text-xs border border-slate-800 rounded px-2.5 py-1.5">
                  <span className="text-slate-300">{REASON_LABELS[b.reason] ?? b.reason}</span>
                  <span className="text-slate-400 font-mono">{b.count.toLocaleString()}</span>
                </div>
              ))}
              {filtered && filtered.breakdown.length === 0 && (
                <div className="text-sm text-slate-500">Nothing filtered in this range.</div>
              )}
            </div>
            <div className="max-h-72 overflow-y-auto custom-scrollbar">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                    <th className="py-1.5 pr-2">Subject</th>
                    <th className="py-1.5 pr-2">Counterpart</th>
                    <th className="py-1.5 pr-2">Reason</th>
                    <th className="py-1.5 pr-0">When</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered?.sample.map((s, i) => (
                    <tr key={i} className="border-b border-slate-800/50">
                      <td className="py-1.5 pr-2 text-slate-300 max-w-[240px] truncate">{s.subject || "(no subject)"}</td>
                      <td className="py-1.5 pr-2 text-slate-400 max-w-[180px] truncate">{s.counterpart}</td>
                      <td className="py-1.5 pr-2 text-slate-500">{REASON_LABELS[s.reason] ?? s.reason}</td>
                      <td className="py-1.5 pr-0 text-slate-500 whitespace-nowrap">
                        {new Date(s.internalDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
