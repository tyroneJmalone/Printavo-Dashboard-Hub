import { useMemo, useState } from "react";
import { Link } from "wouter";
import type { SalesFollowupRecord, SalesFollowupStatus } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Columns3, List, Search, AlertTriangle } from "lucide-react";
import { STATUSES, fmtDay, statusMeta, todayIso, useSalesActions } from "./salesUtils";

export function StatusSelect({ record, compact }: { record: SalesFollowupRecord; compact?: boolean }) {
  const { save, busy } = useSalesActions();
  return (
    <Select
      value={record.followup.status}
      disabled={busy}
      onValueChange={(v) => {
        if (v === "snoozed") {
          const d = window.prompt("Snooze until (YYYY-MM-DD)?", "");
          if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d <= todayIso()) return;
          save({ kind: "followup", id: record.id, version: record.version, followup: { ...record.followup, status: "snoozed", dueDate: d } }, `Snoozed until ${d}`);
          return;
        }
        save({ kind: "followup", id: record.id, version: record.version, followup: { ...record.followup, status: v as SalesFollowupStatus } }, "Status updated");
      }}
    >
      <SelectTrigger className={`${compact ? "h-7 text-[11px]" : "h-8 text-xs"} border ${statusMeta(record.followup.status).tone}`} data-testid={`select-status-${record.id}`} onClick={(e) => e.stopPropagation()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const SOURCE_LABEL: Record<string, string> = { manual: "Manual", event: "Event", anniversary: "Anniversary", custom_field: "Field reminder" };

export function FollowupBoard({ followups, customerNames, onEdit }: { followups: SalesFollowupRecord[]; customerNames: Map<string, string>; onEdit: (r: SalesFollowupRecord) => void }) {
  const [view, setView] = useState<"board" | "list">("board");
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const today = todayIso();
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return followups
      .filter((f) => !s || f.followup.title.toLowerCase().includes(s) || (customerNames.get(f.followup.customerId) ?? "").toLowerCase().includes(s))
      .sort((a, b) => a.followup.dueDate.localeCompare(b.followup.dueDate));
  }, [followups, q, customerNames]);
  const columns = STATUSES.filter((s) => showClosed || (s.value !== "dismissed" && s.value !== "completed"));
  const overdue = (f: SalesFollowupRecord) => f.followup.dueDate < today && !["dismissed", "completed"].includes(f.followup.status);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input className="pl-8 w-64 h-9" placeholder="Filter by customer or title…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="input-filter-followups" />
        </div>
        <label className="text-xs text-slate-400 flex items-center gap-2">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-emerald-500" /> Show dismissed and completed
        </label>
        <div className="ml-auto inline-flex rounded-lg border border-slate-800 p-0.5">
          {(["board", "list"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`px-2.5 py-1 rounded-md text-xs inline-flex items-center gap-1.5 ${view === v ? "bg-slate-800 text-white" : "text-slate-400"}`} data-testid={`toggle-view-${v}`}>
              {v === "board" ? <Columns3 size={13} /> : <List size={13} />} {v === "board" ? "Board" : "List"}
            </button>
          ))}
        </div>
      </div>

      {followups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 px-6 py-14 text-center">
          <p className="text-slate-300 font-medium">No follow-ups yet</p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Create one manually, from an event audience, or from a customer's invoice anniversary in the History tab.</p>
        </div>
      ) : view === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-3 custom-scrollbar">
          {columns.map((col) => {
            const items = filtered.filter((f) => f.followup.status === col.value);
            return (
              <div key={col.value} className="w-72 flex-shrink-0 rounded-xl border border-slate-800 bg-slate-900/30">
                <div className="px-3 py-2.5 border-b border-slate-800 flex items-center justify-between">
                  <span className={`text-[11px] font-semibold uppercase tracking-wider rounded border px-1.5 py-0.5 ${col.tone}`}>{col.label}</span>
                  <span className="text-xs text-slate-500 tabular-nums">{items.length}</span>
                </div>
                <div className="p-2 space-y-2 max-h-[62vh] overflow-y-auto custom-scrollbar">
                  {items.length === 0 && <p className="text-[11px] text-slate-600 text-center py-4">Empty</p>}
                  {items.map((f) => (
                    <div key={f.id} onClick={() => onEdit(f)} className="cursor-pointer rounded-lg border border-slate-800 bg-[#0f172a] p-2.5 hover:border-slate-600 transition-colors" data-testid={`card-followup-${f.id}`}>
                      <p className="text-sm text-slate-100 font-medium leading-snug">{f.followup.title}</p>
                      <Link href={`/customers/${f.followup.customerId}`} onClick={(e) => e.stopPropagation()} className="text-xs text-emerald-400 hover:underline">
                        {customerNames.get(f.followup.customerId) ?? f.followup.customerId}
                      </Link>
                      <div className="flex items-center justify-between mt-2 gap-2">
                        <span className={`text-[11px] tabular-nums inline-flex items-center gap-1 ${overdue(f) ? "text-red-400" : "text-slate-400"}`}>
                          {overdue(f) && <AlertTriangle size={11} />}
                          {f.followup.status === "snoozed" ? "until " : ""}{fmtDay(f.followup.dueDate)}
                        </span>
                        <span className="text-[10px] text-slate-500">{SOURCE_LABEL[f.followup.sourceType]}{f.followup.owner ? ` · ${f.followup.owner.split("@")[0]}` : ""}</span>
                      </div>
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}><StatusSelect record={f} compact /></div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="border border-slate-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
                <th className="px-4 py-2.5 text-left">Due</th>
                <th className="px-4 py-2.5 text-left">Follow-up</th>
                <th className="px-4 py-2.5 text-left">Customer</th>
                <th className="px-4 py-2.5 text-left">Owner</th>
                <th className="px-4 py-2.5 text-left">Source</th>
                <th className="px-4 py-2.5 text-left w-44">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {filtered.filter((f) => showClosed || !["dismissed", "completed"].includes(f.followup.status)).map((f) => (
                <tr key={f.id} className="hover:bg-slate-900/40 cursor-pointer" onClick={() => onEdit(f)}>
                  <td className={`px-4 py-2 tabular-nums whitespace-nowrap ${overdue(f) ? "text-red-400" : "text-slate-300"}`}>{fmtDay(f.followup.dueDate)}</td>
                  <td className="px-4 py-2 text-slate-100">{f.followup.title}</td>
                  <td className="px-4 py-2"><Link href={`/customers/${f.followup.customerId}`} onClick={(e) => e.stopPropagation()} className="text-emerald-400 hover:underline">{customerNames.get(f.followup.customerId) ?? f.followup.customerId}</Link></td>
                  <td className="px-4 py-2 text-slate-400">{f.followup.owner || "—"}</td>
                  <td className="px-4 py-2 text-slate-500 text-xs">{SOURCE_LABEL[f.followup.sourceType]}</td>
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}><StatusSelect record={f} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
