import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarRange, ChevronLeft, ChevronRight, Info, X } from "lucide-react";
import {
  useGetProductionWorkload,
  getGetProductionWorkloadQueryKey,
  type GetProductionWorkloadParams,
  type ProductionWorkloadPeriod,
  type ProductionWorkloadJob,
  type DecorationProductionTotals,
} from "@workspace/api-client-react";
import { formatNumber } from "@/lib/format";
import { JobCard, MerchToggle, MethodToggle, Stat, WorkUnits, num, workLabel, type Merch, type Method } from "@/components/DecorationProductionReport";

const TZ = "America/New_York";
const MAX_DAYS = 92;
const PAGE = 20;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayNY() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  // Native date inputs can emit partial/invalid values while being edited.
  // Validation blocks the request; derived input attributes must not crash.
  if (!Number.isFinite(x.getTime())) return "";
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function diffDays(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
const ymd = (s: string) => s.slice(0, 10);
const weekday = (s: string) => new Date(`${ymd(s)}T00:00:00Z`).getUTCDay();
function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(`${ymd(s)}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;

type Preset = "next7" | "next14" | "custom";
type Selection = { label: string; jobIds: string[] };

function Metrics({ t, locations, method }: { t: DecorationProductionTotals; locations: number; method: Method }) {
  return method === "print" ? (
    <>
      <td className="px-3 py-2 text-right tabular-nums"><WorkUnits t={t} method={method} /></td>
      <td className="px-3 py-2 text-right tabular-nums">{num(t.imprints)}</td>
    </>
  ) : (
    <>
      <td className="px-3 py-2 text-right tabular-nums"><WorkUnits t={t} method={method} /></td>
      <td className="px-3 py-2 text-right tabular-nums">{num(t.imprints)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{num(locations)}</td>
    </>
  );
}
function MetricHeads({ method }: { method: Method }) {
  return method === "print" ? (
    <><th className="px-3 py-2 text-right">Impressions</th><th className="px-3 py-2 text-right">Imprints</th></>
  ) : (
    <><th className="px-3 py-2 text-right">Est. stitches</th><th className="px-3 py-2 text-right" title="Quantity x locations">Applications</th><th className="px-3 py-2 text-right" title="Assigned location records">Locations</th></>
  );
}

function OpenBtn({ p, label, onOpen, testId }: { p: ProductionWorkloadPeriod; label: string; onOpen: (s: Selection) => void; testId: string }) {
  if (!p.jobIds.length) return <span className="text-slate-500">{label}</span>;
  return (
    <button type="button" onClick={() => onOpen({ label, jobIds: p.jobIds })} data-testid={testId}
      className="text-left font-semibold text-slate-100 underline decoration-emerald-600 underline-offset-4 hover:text-emerald-300">{label}</button>
  );
}

export function ProductionWorkloadView({ method, setMethod, merch, setMerch }: { method: Method; setMethod: (m: Method) => void; merch: Merch; setMerch: (m: Merch) => void }) {
  const today = useMemo(todayNY, []);
  const [preset, setPreset] = useState<Preset>("next14");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(addDays(today, 13));
  const [baselineWeeks, setBaselineWeeks] = useState<4 | 8 | 12>(8);
  const [grain, setGrain] = useState<"day" | "week">("day");
  const [histGrain, setHistGrain] = useState<"day" | "week">("week");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [page, setPage] = useState(0);

  const customSpan = diffDays(customStart, customEnd) + 1;
  const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  const customError = !customStart || !customEnd ? "Choose both dates." : !validDate(customStart) || !validDate(customEnd) ? "Enter valid calendar dates." : customStart < today ? "Start cannot be before today (Eastern time)." : customSpan < 1 ? "End must be on or after start." : customSpan > MAX_DAYS ? `Range is limited to ${MAX_DAYS} days.` : null;
  const range = preset === "next7" ? { start: today, end: addDays(today, 6) } : preset === "next14" ? { start: today, end: addDays(today, 13) } : { start: customStart, end: customEnd };

  const params: GetProductionWorkloadParams = { start: range.start, end: range.end, method, merch, baselineWeeks };
  const enabled = preset !== "custom" || !customError;
  const { data, isLoading, isFetching, isError, refetch } = useGetProductionWorkload(params, {
    query: { enabled, queryKey: getGetProductionWorkloadQueryKey(params) },
  });

  const key = JSON.stringify(params);
  useEffect(() => { setSelection(null); setPage(0); }, [key]);

  const jobMap = useMemo(() => new Map((data?.jobs ?? []).map((j) => [j.job.id, j])), [data]);
  const selectedJobs = useMemo(() => (selection ? selection.jobIds.map((id) => jobMap.get(id)).filter(Boolean) as ProductionWorkloadJob[] : []), [selection, jobMap]);
  const pages = Math.max(1, Math.ceil(selectedJobs.length / PAGE));

  // Typical observed output (not capacity)
  const weeklyAvg = data && data.historyCoversBaseline && data.history.totals.workUnits !== null ? data.history.totals.workUnits / data.baselineWeeks : null;
  const weekdayAvg = useMemo(() => {
    if (!data || !data.historyCoversBaseline || data.historyDays.some((d) => d.totals.workUnits === null)) return null;
    const sums = new Map<number, { s: number; n: number }>();
    for (const d of data.historyDays) {
      const w = weekday(d.start);
      const c = sums.get(w) ?? { s: 0, n: 0 };
      c.s += d.totals.workUnits ?? 0; c.n += 1; sums.set(w, c);
    }
    return sums;
  }, [data]);

  const open = (s: Selection) => { setSelection(s); setPage(0); requestAnimationFrame(() => document.getElementById("workload-jobs")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const unit = workLabel(method).toLowerCase();

  return (
    <div className="space-y-4" data-testid="production-workload-view">
      <div role="note" className="flex items-start gap-2 rounded-lg border border-sky-800/60 bg-sky-950/20 p-3 text-xs text-sky-200" data-testid="text-workload-scope">
        <CalendarRange size={15} className="mt-0.5 shrink-0" />
        <div>
          <strong className="font-semibold">Independent date range.</strong> Schedule &amp; Capacity uses only the due-date range, method and merch filter below. It ignores the Orders Report invoice-created dates, status, quantity and other filters. Invoices only; Heat excluded; Chipply sales revenue is not added. Waiting and on-hold work counts as scheduled, not necessarily ready to run.
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <MethodToggle method={method} onChange={setMethod} />
        <MerchToggle merch={merch} onChange={setMerch} />
        <div className="flex rounded-md border border-slate-700 bg-slate-900 p-0.5" role="radiogroup" aria-label="Date range">
          {([["next7", "Next 7 days"], ["next14", "Next 14 days"], ["custom", "Custom"]] as [Preset, string][]).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={preset === v} data-testid={`button-range-${v}`} onClick={() => setPreset(v)}
              className={`px-3 py-1.5 text-xs font-medium rounded ${preset === v ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}>{l}</button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-1 text-slate-400">Start
              <input type="date" value={customStart} min={today} onChange={(e) => setCustomStart(e.target.value)} data-testid="input-workload-start"
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100" />
            </label>
            <label className="flex flex-col gap-1 text-slate-400">End
              <input type="date" value={customEnd} min={validDate(customStart) ? customStart : undefined} max={validDate(customStart) ? addDays(customStart, MAX_DAYS - 1) : undefined} onChange={(e) => setCustomEnd(e.target.value)} data-testid="input-workload-end"
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100" />
            </label>
          </div>
        )}
        <label className="flex flex-col gap-1 text-xs text-slate-400">Baseline
          <select value={baselineWeeks} onChange={(e) => setBaselineWeeks(Number(e.target.value) as 4 | 8 | 12)} data-testid="select-baseline-weeks"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100">
            <option value={4}>Recent 4 full weeks</option><option value={8}>Recent 8 full weeks</option><option value={12}>Recent 12 full weeks</option>
          </select>
        </label>
      </div>
      {preset === "custom" && customError && <p role="alert" className="text-xs text-amber-300" data-testid="text-range-error">{customError}</p>}
      <p className="text-[11px] text-slate-500">Range {fmtDate(range.start)} to {fmtDate(range.end)} (Eastern time){isFetching && !isLoading ? " · updating…" : ""}</p>

      {!enabled ? null : isError ? (
        <p role="alert" className="rounded-lg border border-red-900 bg-red-950/20 p-6 text-red-300">
          Unable to load schedule and capacity. <button className="underline" onClick={() => refetch()} data-testid="button-retry-workload">Retry</button>
        </p>
      ) : isLoading || !data ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading schedule">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-slate-800/60" />)}</div>
          <div className="h-56 animate-pulse rounded-xl bg-slate-800/40" />
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="workload-summary">
            {([["Scheduled in range", data.scheduled], ["Unscheduled (no due date)", data.unscheduled], ["Unclear status", data.unclear]] as [string, ProductionWorkloadPeriod][]).map(([l, p]) => (
              <button key={l} type="button" disabled={!p.jobIds.length} onClick={() => open({ label: l, jobIds: p.jobIds })} data-testid={`button-bucket-${p.key}`}
                className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-left transition-colors hover:border-emerald-700 disabled:cursor-default disabled:hover:border-slate-800">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{l}</div>
                <div className="mt-1 text-lg font-bold tabular-nums text-white"><WorkUnits t={p.totals} method={method} /></div>
                <div className="text-[11px] text-slate-400">{unit} · {num(p.totals.invoices)} invoices · {num(p.totals.imprints)} {method === "print" ? "imprints" : "applications"}{method === "embroidery" ? ` · ${num(p.locations)} locations` : ""}</div>
              </button>
            ))}
            <Stat label={`Typical weekly output (${data.baselineWeeks} wk)`} hint="Production-date average, not maximum capacity">
              {weeklyAvg !== null ? num(Math.round(weeklyAvg)) : <span className="text-sm text-amber-300">Not available</span>}
              <div className="text-[11px] font-normal text-slate-400">{fmtDate(data.baselineStart)} to {fmtDate(data.baselineEnd)}</div>
            </Stat>
          </section>

          <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3 text-[11px] text-slate-400 space-y-1">
            <p className="flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />
              Historical output uses each invoice’s past Production Due date as its produced date, regardless of status. Today’s and future dates do not establish completed production. Totals use current invoice quantities; later pickup/shipping status changes do not add another production run. These averages are a reference, not maximum capacity.
              {weeklyAvg === null && (data.historyCoversBaseline ? " Average withheld because some historic work units are unknown." : ` Average withheld: stored production dates begin ${fmtDate(data.historyAvailableFrom)}, which does not cover the full baseline.`)}
            </p>
            <p>For jobs without a past Production Due date, recognized completion statuses determine whether work is still pending, but do not supply a production date: {data.recognizedCompletionStatuses.length ? data.recognizedCompletionStatuses.join(", ") : "none matched"}. Merch is classified per invoice (Chipply nickname, line flag, or current/history MERCH status).</p>
            <p>Baseline history: <OpenBtn p={data.history} label={`${num(data.history.totals.invoices)} completed invoices`} onOpen={open} testId="button-open-history" /></p>
          </div>

          {(() => {
            const w: [number, string][] = ([
              [data.undatedCompletedInvoices, "completed-status invoices without a past Production Due date; excluded from historical output"],
              [data.excludedIncompleteInvoices, "invoices excluded because detail data is incomplete"],
              [data.unclassifiedGroups, "groups excluded for unknown or conflicting method"],
              [data.excludedQuantityGroups, "groups excluded for missing or invalid quantity"],
            ] as [number, string][]).filter(([n]) => n > 0);
            return w.length ? (
              <div className="rounded-lg border border-amber-900/50 bg-amber-950/10 p-3 text-xs text-amber-200" data-testid="workload-caveats">
                <div className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle size={13} /> Data quality</div>
                <ul className="list-disc pl-5 space-y-0.5">{w.map(([n, l]) => <li key={l}><span className="font-semibold tabular-nums">{formatNumber(n)}</span> {l}</li>)}</ul>
              </div>
            ) : null;
          })()}

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-white">Scheduled by due date</h3>
              <div className="flex rounded-md border border-slate-700 bg-slate-900 p-0.5" role="radiogroup" aria-label="Grouping">
                {(["day", "week"] as const).map((g) => (
                  <button key={g} type="button" role="radio" aria-checked={grain === g} data-testid={`button-grain-${g}`} onClick={() => setGrain(g)}
                    className={`px-3 py-1 text-xs rounded ${grain === g ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}>{g === "day" ? "Daily" : "Weekly"}</button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-xs">
                <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">{grain === "day" ? "Due date" : "Week"}</th>
                    <th className="px-3 py-2 text-right">Invoices</th><th className="px-3 py-2 text-right">Qty</th>
                    <MetricHeads method={method} />
                    <th className="px-3 py-2 text-right">Typical output</th><th className="px-3 py-2 text-right">vs typical</th>
                  </tr>
                </thead>
                <tbody>
                  {(grain === "day" ? data.days : data.weeks).map((p) => {
                    let typical: number | null = null;
                    let note = "";
                    if (grain === "day") {
                      const c = weekdayAvg?.get(weekday(p.start));
                      typical = c && c.n ? c.s / c.n : null;
                    } else {
                      const full = weekday(p.start) === 1 && diffDays(ymd(p.start), ymd(p.end)) === 6 && ymd(p.start) >= range.start && ymd(p.end) <= range.end;
                      typical = full ? weeklyAvg : null;
                      if (!full) note = "Partial week";
                    }
                    const label = grain === "day" ? fmtDate(p.start) : `${fmtDate(p.start)} – ${fmtDate(p.end)}`;
                    const wu = p.totals.workUnits;
                    return (
                      <tr key={p.key} className="border-t border-slate-800 text-slate-300" data-testid={`row-period-${p.key}`}>
                        <td className="px-3 py-2 whitespace-nowrap"><OpenBtn p={p} label={label} onOpen={open} testId={`button-period-${p.key}`} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(p.totals.invoices)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(p.totals.quantity)}</td>
                        <Metrics t={p.totals} locations={p.locations} method={method} />
                        <td className="px-3 py-2 text-right tabular-nums text-slate-400">{typical !== null ? num(Math.round(typical)) : <span className="text-slate-600">{note || "—"}</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{typical && wu !== null ? pct(wu, typical) : <span className="text-slate-600">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">Typical output = average {unit} produced {grain === "day" ? "on the same weekday" : "per full Mon–Sun week"} by Production Due date over the baseline. Partial weeks are never compared with full-week output. Past-dated invoices count as produced, not overdue; work without a date is shown separately above.</p>
          </section>

          {(data.historyWeeks.length > 0 || data.historyDays.length > 0) && (
            <details className="rounded-lg border border-slate-800 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-white" data-testid="toggle-history-weeks">Baseline history (Production Dates)</summary>
              <div className="mt-2 flex rounded-md border border-slate-700 bg-slate-900 p-0.5 w-fit" role="radiogroup" aria-label="History grouping">
                {(["day", "week"] as const).map((g) => (
                  <button key={g} type="button" role="radio" aria-checked={histGrain === g} data-testid={`button-history-grain-${g}`} onClick={() => setHistGrain(g)}
                    className={`px-3 py-1 text-xs rounded ${histGrain === g ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}>{g === "day" ? "Daily" : "Weekly"}</button>
                ))}
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>
                    <th className="px-3 py-2 text-left">{histGrain === "day" ? "Completed on" : "Week"}</th><th className="px-3 py-2 text-right">Invoices</th><th className="px-3 py-2 text-right">Qty</th><MetricHeads method={method} />
                  </tr></thead>
                  <tbody>{(histGrain === "day" ? data.historyDays : data.historyWeeks).map((p) => (
                    <tr key={p.key} className="border-t border-slate-800 text-slate-300">
                      <td className="px-3 py-2 whitespace-nowrap"><OpenBtn p={p} label={histGrain === "day" ? `Completed ${fmtDate(p.start)}` : `Completed ${fmtDate(p.start)} – ${fmtDate(p.end)}`} onOpen={open} testId={`button-history-${histGrain}-${p.key}`} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(p.totals.invoices)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(p.totals.quantity)}</td>
                      <Metrics t={p.totals} locations={p.locations} method={method} />
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </details>
          )}

          <section id="workload-jobs" aria-live="polite">
            {!selection ? (
              <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400" data-testid="text-workload-empty">
                {data.jobs.length === 0 ? `No ${method} invoices in this range or baseline.` : "Select a day, week, or bucket to see its contributing invoices."}
              </div>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-white">{selection.label} <span className="font-normal text-slate-400">({formatNumber(selectedJobs.length)} invoices)</span></h3>
                  <button type="button" onClick={() => setSelection(null)} data-testid="button-clear-selection" className="flex items-center gap-1 rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">Close <X size={11} /></button>
                </div>
                <div className="space-y-3">
                  {selectedJobs.slice(page * PAGE, page * PAGE + PAGE).map((j) => (
                    <div key={j.job.id} className="space-y-1">
                      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400" data-testid={`text-job-meta-${j.job.id}`}>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-slate-200">{j.disposition}</span>
                        <span>Status: <span className="text-slate-200">{j.status ?? "—"}</span></span>
                        <span>Due: <span className="text-slate-200">{fmtDate(j.dueDate)}</span></span>
                        {j.completedDate && <span>Produced (Production Due): <span className="text-slate-200">{fmtDate(j.completedDate)}</span></span>}
                        {j.merch && <span className="text-sky-300">Merch</span>}
                      </div>
                      <JobCard job={j.job} method={method} />
                    </div>
                  ))}
                </div>
                {pages > 1 && (
                  <div className="mt-3 flex items-center justify-end gap-3 text-xs text-slate-400">
                    <span>Page {page + 1} of {pages}</span>
                    <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)} data-testid="button-workload-prev" className="rounded border border-slate-700 p-1 disabled:opacity-40"><ChevronLeft size={14} /></button>
                    <button type="button" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} data-testid="button-workload-next" className="rounded border border-slate-700 p-1 disabled:opacity-40"><ChevronRight size={14} /></button>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
