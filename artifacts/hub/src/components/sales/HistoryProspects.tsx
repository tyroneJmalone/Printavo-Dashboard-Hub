import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  useGetSalesHistory,
  getGetSalesHistoryQueryKey,
  type SalesFollowup,
  type SalesFollowupRecord,
  type SalesProspect,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney, formatNumber } from "@/lib/format";
import { ChevronLeft, ChevronRight, Loader2, Plus, FileText } from "lucide-react";
import { addDays, addYears, fmtDay, isoDate, todayIso } from "./salesUtils";

/** Default follow-up for an anniversary: 6 weeks ahead, never before today, never after the anniversary. */
export function anniversaryFollowup(p: SalesProspect, anniversary: string, owner = ""): Partial<SalesFollowup> & { customerName: string } {
  const today = todayIso();
  let due = addDays(anniversary, -42);
  if (due < today) due = today;
  if (due > anniversary && anniversary >= today) due = anniversary;
  const anchor = p.invoices.find(i => addYears(i.date, 1) === anniversary) ?? p.invoices[0];
  const nick = anchor?.nickname;
  return {
    customerId: p.customerId,
    customerName: p.name,
    title: `Anniversary: ${nick ?? "last year's order"}`,
    dueDate: due,
    status: "needs_contact",
    owner: owner || anchor?.owner || "",
    notes: `Based on ${p.invoices.length} invoice${p.invoices.length === 1 ? "" : "s"} last year (${p.invoices.map((i) => `#${i.number}`).join(", ")}). Possible reorder — not confirmed.`,
    sourceType: "anniversary",
    sourceId: anchor?.id ?? p.customerId,
    occurrenceDate: anniversary,
    invoiceIds: p.invoices.map((i) => i.id),
  };
}

type Preset = "ttly" | "next30" | "next60" | "next90" | "months";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function rangeFor(preset: Preset, m1: number, m2: number): { from: string; to: string; label: string } {
  const t = todayIso();
  const ly = addYears(t, -1);
  if (preset === "ttly") return { from: addDays(ly, -14), to: addDays(ly, 14), label: "two weeks either side of today, last year" };
  if (preset === "months") {
    const y = new Date().getFullYear() - 1;
    const endYear = m2 < m1 ? y + 1 : y;
    return { from: isoDate(new Date(y, m1, 1)), to: isoDate(new Date(endYear, m2 + 1, 0)), label: `${MONTHS[m1]}–${MONTHS[m2]} ${y}${endYear !== y ? `/${endYear}` : ""}` };
  }
  const n = preset === "next30" ? 30 : preset === "next60" ? 60 : 90;
  return { from: ly, to: addDays(ly, n), label: `invoices from one year ago whose anniversary falls in the next ${n} days` };
}

export function HistoryProspects({ owner, nicheId, followups, onCreate }: { owner?: string; nicheId?: string; followups: SalesFollowupRecord[]; onCreate: (init: Partial<SalesFollowup> & { customerName: string }) => void }) {
  const [preset, setPreset] = useState<Preset>("next60");
  const [basis, setBasis] = useState<"invoice" | "customerDue">("invoice");
  const nowM = new Date().getMonth();
  const [m1, setM1] = useState(nowM);
  const [m2, setM2] = useState((nowM + 2) % 12);
  const [page, setPage] = useState(0);
  const r = rangeFor(preset, m1, m2);
  useEffect(() => setPage(0), [preset, basis, m1, m2, owner, nicheId]);

  const params = { from: r.from, to: r.to, dateBasis: basis, offset: page * 50, ...(owner ? { owner } : {}), ...(nicheId ? { nicheId } : {}) };
  const { data, isLoading, isError, isFetching, refetch } = useGetSalesHistory(params, { query: { queryKey: getGetSalesHistoryQueryKey(params), refetchInterval: 60_000 } });
  const anniversaryFollowedUp = new Set(followups.filter((f) => f.followup.sourceType === "anniversary").map((f) => `${f.followup.customerId}|${f.followup.sourceId}`));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <div className="inline-flex flex-wrap rounded-lg border border-slate-800 p-0.5">
          {([["ttly", "This time last year"], ["next30", "Next 30"], ["next60", "Next 60"], ["next90", "Next 90"], ["months", "Chosen months"]] as [Preset, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setPreset(k)} className={`px-2.5 py-1 rounded-md text-xs ${preset === k ? "bg-slate-800 text-white" : "text-slate-400"}`} data-testid={`preset-${k}`}>{l}</button>
          ))}
        </div>
        {preset === "months" && (
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Select value={String(m1)} onValueChange={(v) => setM1(Number(v))}><SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger><SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i)}>{m}</SelectItem>)}</SelectContent></Select>
            through
            <Select value={String(m2)} onValueChange={(v) => setM2(Number(v))}><SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger><SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i)}>{m}</SelectItem>)}</SelectContent></Select>
            last year
          </div>
        )}
        <Select value={basis} onValueChange={(v) => setBasis(v as typeof basis)}>
          <SelectTrigger className="h-8 w-48 ml-auto"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="invoice">By invoice date</SelectItem>
            <SelectItem value="customerDue">By customer due date</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Showing {r.label} ({fmtDay(r.from)} – {fmtDay(r.to)}). Prior orders suggest an opportunity; they don't confirm a reorder.
        {isFetching && !isLoading && <Loader2 size={11} className="inline animate-spin ml-1" />}
      </p>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-20 rounded-xl bg-slate-900/60 animate-pulse" />)}</div>
      ) : isError ? (
        <div className="rounded-xl border border-red-900/50 bg-red-950/20 px-4 py-6 text-center">
          <p className="text-sm text-red-300">Could not load invoice history.</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>Retry</Button>
        </div>
      ) : (data?.customers ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 px-6 py-14 text-center">
          <p className="text-slate-300 font-medium">No invoices in this window</p>
          <p className="text-xs text-slate-500 mt-1">Try a wider range, another date basis, or clear the owner and niche filters.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(data?.customers ?? []).map((p) => {
            const anniv = addYears(p.invoices[0]?.date ?? r.from, 1);
            const done = anniversaryFollowedUp.has(`${p.customerId}|${p.invoices[0]?.id ?? p.customerId}`);
            const revenue = p.invoices.reduce((s, i) => s + i.total, 0);
            return (
              <div key={p.customerId} className="rounded-xl border border-slate-800 bg-slate-900/30 p-3" data-testid={`row-prospect-${p.customerId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/customers/${p.customerId}`} className="font-semibold text-slate-100 hover:text-emerald-400">{p.name}</Link>
                  {p.niche && <span className="text-[10px] rounded border border-slate-700 px-1.5 py-0.5 text-slate-400">{p.niche}</span>}
                  {p.latestOrderDate && p.latestOrderDate > addDays(todayIso(), -90) && (
                    <span className="text-[10px] rounded border border-sky-800 bg-sky-950/40 px-1.5 py-0.5 text-sky-300">Ordered recently · {fmtDay(p.latestOrderDate)}</span>
                  )}
                  {p.activeQuoteCount > 0 && (
                    <span className="text-[10px] rounded border border-violet-800 bg-violet-950/40 px-1.5 py-0.5 text-violet-300" title="Non-cancelled, non-converted quote records in synced history. Check the customer profile to confirm whether they are still active or related to this event.">{p.activeQuoteCount} quote record{p.activeQuoteCount === 1 ? "" : "s"}</span>
                  )}
                  <span className="ml-auto text-xs text-slate-400 tabular-nums">{formatMoney(revenue)} · anniversary {fmtDay(anniv)}</span>
                  <Button size="sm" variant={done ? "ghost" : "outline"} className="h-7 gap-1" disabled={done} onClick={() => onCreate(anniversaryFollowup(p, anniv, owner))} data-testid={`button-followup-prospect-${p.customerId}`}>
                    {done ? "Follow-up exists" : <><Plus size={12} /> Follow-up</>}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {p.invoices.map((i) => (
                    <span key={i.id} className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-[#0f172a] px-2 py-1 text-[11px] text-slate-300">
                      <FileText size={11} className="text-slate-500" />
                      <span className="text-slate-500 tabular-nums">{fmtDay(i.date)}</span>
                      #{i.number}{i.nickname ? ` ${i.nickname}` : ""}
                      <span className="text-slate-500 tabular-nums">· {formatNumber(i.quantity)} pcs · {formatMoney(i.total)}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-slate-500">Customers {page * 50 + 1}–{page * 50 + (data?.customers.length ?? 0)}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={14} /> Prev</Button>
              <Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage(page + 1)}>Next <ChevronRight size={14} /></Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
