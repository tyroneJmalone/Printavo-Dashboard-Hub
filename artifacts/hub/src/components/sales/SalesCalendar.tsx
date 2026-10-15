import { useMemo, useState } from "react";
import {
  useGetSalesHistory,
  getGetSalesHistoryQueryKey,
  type SalesFollowupRecord,
  type SalesOccurrence,
  type SalesProspect,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { addYears, isoDate, parseIso, statusMeta } from "./salesUtils";

export type CalendarMode = "event" | "outreach";

export function SalesCalendar({
  month, setMonth, occurrences, followups, customerNames, owner, nicheId, onOccurrence, onFollowup, onAnniversary,
}: {
  month: Date;
  setMonth: (d: Date) => void;
  occurrences: SalesOccurrence[];
  followups: SalesFollowupRecord[];
  customerNames: Map<string, string>;
  owner?: string;
  nicheId?: string;
  onOccurrence: (o: SalesOccurrence) => void;
  onFollowup: (f: SalesFollowupRecord) => void;
  onAnniversary: (p: SalesProspect, anniversary: string) => void;
}) {
  const [mode, setMode] = useState<CalendarMode>("event");
  const [showFollowups, setShowFollowups] = useState(true);
  const [showAnniv, setShowAnniv] = useState(false);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const days: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(isoDate(d));
  }
  const monthFrom = isoDate(first);
  const monthTo = isoDate(last);

  const histParams = {
    from: addYears(monthFrom, -1),
    to: addYears(monthTo, -1),
    dateBasis: "invoice" as const,
    ...(owner ? { owner } : {}),
    ...(nicheId ? { nicheId } : {}),
  };
  const [annivPage, setAnnivPage] = useState(0);
  const hp = { ...histParams, offset: annivPage * 50 };
  const hist = useGetSalesHistory(hp, { query: { queryKey: getGetSalesHistoryQueryKey(hp), enabled: showAnniv } });

  const byDay = useMemo(() => {
    const m = new Map<string, { occ: SalesOccurrence[]; fu: SalesFollowupRecord[]; anniv: { p: SalesProspect; date: string; label: string }[] }>();
    const get = (d: string) => { let v = m.get(d); if (!v) { v = { occ: [], fu: [], anniv: [] }; m.set(d, v); } return v; };
    for (const o of occurrences) get(mode === "event" ? o.date : o.outreachDate).occ.push(o);
    if (showFollowups) for (const f of followups) get(f.followup.dueDate).fu.push(f);
    if (showAnniv) for (const p of hist.data?.customers ?? []) for (const inv of p.invoices) {
      const d = addYears(inv.date, 1);
      get(d).anniv.push({ p, date: d, label: `${p.name} #${inv.number}` });
    }
    return m;
  }, [occurrences, followups, mode, showFollowups, showAnniv, hist.data]);

  const today = isoDate(new Date());
  const shift = (n: number) => { setAnnivPage(0); setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1)); };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={14} /></Button>
          <Button size="sm" variant="outline" onClick={() => { setAnnivPage(0); setMonth(new Date()); }}>Today</Button>
          <Button size="sm" variant="outline" onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={14} /></Button>
        </div>
        <h2 className="text-lg font-semibold text-white tracking-tight" data-testid="text-calendar-month">
          {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </h2>
        <div className="inline-flex rounded-lg border border-slate-800 p-0.5 ml-auto">
          {(["event", "outreach"] as const).map((v) => (
            <button key={v} onClick={() => setMode(v)} className={`px-2.5 py-1 rounded-md text-xs ${mode === v ? "bg-slate-800 text-white" : "text-slate-400"}`} data-testid={`toggle-calendar-${v}`}>
              {v === "event" ? "Event dates" : "Outreach dates"}
            </button>
          ))}
        </div>
        <label className="text-xs text-slate-400 flex items-center gap-1.5"><input type="checkbox" className="accent-emerald-500" checked={showFollowups} onChange={(e) => setShowFollowups(e.target.checked)} /> Follow-ups</label>
        <label className="text-xs text-slate-400 flex items-center gap-1.5"><input type="checkbox" className="accent-amber-500" checked={showAnniv} onChange={(e) => setShowAnniv(e.target.checked)} data-testid="toggle-anniversaries" /> Invoice anniversaries</label>
      </div>

      {showAnniv && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-amber-300/80 rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2">
          <span>Dashed amber items are last year's invoices shown one year later — possible opportunities, not confirmed reorders.</span>
          {hist.isFetching && <Loader2 size={12} className="animate-spin" />}
          {hist.isError && <span className="text-red-400">Could not load anniversaries.</span>}
          <span className="ml-auto flex items-center gap-2">
            {annivPage > 0 && <button className="underline" onClick={() => setAnnivPage(annivPage - 1)}>Previous 50 customers</button>}
            {hist.data?.hasMore && <button className="underline" onClick={() => setAnnivPage(annivPage + 1)}>Next 50 customers</button>}
          </span>
        </div>
      )}

      <div className="grid grid-cols-7 border-l border-t border-slate-800 rounded-xl overflow-hidden">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="border-r border-b border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{d}</div>
        ))}
        {days.map((d) => {
          const inMonth = parseIso(d).getMonth() === month.getMonth();
          const cell = byDay.get(d);
          return (
            <div key={d} className={`min-h-[110px] border-r border-b border-slate-800 p-1.5 ${inMonth ? "bg-[#0b1224]" : "bg-[#020617] opacity-50"}`}>
              <div className={`text-[11px] tabular-nums mb-1 ${d === today ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white font-bold" : "text-slate-500"}`}>{parseIso(d).getDate()}</div>
              <div className="space-y-1">
                {cell?.occ.map((o) => (
                  <button key={o.key} onClick={() => onOccurrence(o)} title={o.title} className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] ${o.sourceType === "event" ? "bg-sky-900/50 text-sky-200 hover:bg-sky-800/60" : "bg-fuchsia-900/40 text-fuchsia-200 hover:bg-fuchsia-800/50"} ${o.excluded ? "line-through opacity-50" : ""}`}>
                    {mode === "outreach" ? "Reach out: " : ""}{o.title}{o.customerId ? ` · ${customerNames.get(o.customerId) ?? ""}` : ""}
                  </button>
                ))}
                {cell?.fu.map((f) => (
                  <button key={f.id} onClick={() => onFollowup(f)} title={f.followup.title} className={`block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] ${statusMeta(f.followup.status).tone}`}>
                    {customerNames.get(f.followup.customerId) ?? "Customer"}: {f.followup.title}
                  </button>
                ))}
                {cell?.anniv.map((a, i) => (
                  <button key={`${a.label}-${i}`} onClick={() => onAnniversary(a.p, a.date)} title="Possible opportunity — not a confirmed reorder" className="block w-full truncate rounded border border-dashed border-amber-700/60 px-1.5 py-0.5 text-left text-[11px] text-amber-300/90 hover:bg-amber-950/40">
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-4 mt-3 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-sky-700" /> Seasonal / client event</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-fuchsia-700" /> Custom date-field reminder</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded border border-amber-700" /> Follow-up (colored by status)</span>
      </div>
    </div>
  );
}
