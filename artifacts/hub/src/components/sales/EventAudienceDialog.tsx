import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  getSalesWorkspace,
  useListDirectoryCustomers,
  getListDirectoryCustomersQueryKey,
  useListCustomerCategories,
  getListCustomerCategoriesQueryKey,
  type SalesEventRecord,
  type SalesFollowupRecord,
  type SalesOccurrence,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, ChevronLeft, ChevronRight, CheckCircle2, XCircle } from "lucide-react";
import { addDays, errorInfo, fmtDay, nextAnnual, todayIso, useSalesActions } from "./salesUtils";

const NICHE_PAGE = 50;

interface Row { id: string; name: string }

function NicheBlock({ nicheId, nicheName, selected, toggle, existing }: { nicheId: string; nicheName: string; selected: Map<string, string>; toggle: (r: Row) => void; existing: Set<string> }) {
  const [page, setPage] = useState(0);
  const params = { categoryId: nicheId, sort: "spend" as const, limit: NICHE_PAGE, offset: page * NICHE_PAGE };
  const { data, isLoading, isError, refetch } = useListDirectoryCustomers(params, { query: { queryKey: getListDirectoryCustomersQueryKey(params) } });
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / NICHE_PAGE));
  return (
    <div className="rounded-lg border border-slate-800">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/50">
        <p className="text-xs font-semibold text-slate-200">Niche: {nicheName} <span className="text-slate-500 font-normal">· {total} customers</span></p>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={13} /></Button>
          <span className="text-[11px] text-slate-500 tabular-nums">{page + 1}/{pages}</span>
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={13} /></Button>
        </div>
      </div>
      {isLoading ? (
        <div className="p-3 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-5 rounded bg-slate-800/60 animate-pulse" />)}</div>
      ) : isError ? (
        <p className="p-3 text-xs text-red-400">Could not load niche customers. <button className="underline" onClick={() => refetch()}>Retry</button></p>
      ) : (data?.customers ?? []).length === 0 ? (
        <p className="p-3 text-xs text-slate-500">No customers are assigned to this niche yet.</p>
      ) : (
        <div className="divide-y divide-slate-800/60">
          {(data?.customers ?? []).map((c) => (
            <AudienceRow key={c.printavoId} row={{ id: c.printavoId, name: c.displayName }} checked={selected.has(c.printavoId)} toggle={toggle} has={existing.has(c.printavoId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function AudienceRow({ row, checked, toggle, has }: { row: Row; checked: boolean; toggle: (r: Row) => void; has: boolean }) {
  return (
    <label className="flex items-center gap-3 px-3 py-1.5 text-sm hover:bg-slate-900/40">
      <Checkbox checked={checked} disabled={has} onCheckedChange={() => toggle(row)} data-testid={`check-audience-${row.id}`} />
      <span className="flex-1 truncate text-slate-200">{row.name}</span>
      {has && <span className="text-[10px] uppercase tracking-wide text-emerald-400">has follow-up</span>}
      <Link href={`/customers/${row.id}`} className="text-[11px] text-slate-500 hover:text-emerald-400">history</Link>
    </label>
  );
}

export function EventAudienceDialog({
  open, onOpenChange, record, occurrence, customerNames, followups,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  record: SalesEventRecord | null;
  occurrence?: SalesOccurrence | null;
  customerNames: Map<string, string>;
  followups: SalesFollowupRecord[];
}) {
  const { saveRaw, invalidate } = useSalesActions();
  const { data: catData } = useListCustomerCategories({ query: { queryKey: getListCustomerCategoriesQueryKey() } });
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<{ id: string; name: string; ok: boolean; msg?: string }[]>([]);
  useEffect(() => { if (open) { setSelected(new Map()); setResults([]); } }, [open, record?.id]);
  if (!record) return null;
  const ev = record.event;
  const today = todayIso();
  // Prefer the occurrence the dialog was opened from; otherwise the next upcoming one.
  const occDate = occurrence?.originalDate
    ?? (ev.recurrence === "annual" ? nextAnnual(ev.startDate, today, ev.precision) : ev.startDate);
  const pastOnce = !occurrence && ev.recurrence === "once" && (ev.endDate ?? ev.startDate) < today;
  const defaultDue = occurrence?.outreachDate ?? addDays(occDate, -ev.leadDays);
  const existing = new Set(
    followups.filter((f) => f.followup.sourceType === "event" && f.followup.sourceId === record.id && f.followup.occurrenceDate === occDate).map((f) => f.followup.customerId),
  );
  const catName = new Map((catData?.categories ?? []).map((c) => [c.id, c.name]));
  const toggle = (r: Row) => setSelected((prev) => { const n = new Map(prev); if (n.has(r.id)) n.delete(r.id); else n.set(r.id, r.name); return n; });

  const run = async () => {
    setRunning(true);
    const out: typeof results = [];
    for (const [id, name] of selected) {
      try {
        // Apply this client's overrides: find the matching occurrence in their own workspace.
        const ws = await getSalesWorkspace({ customerId: id, from: addDays(occDate, -366), to: addDays(occDate, 366) });
        const match = ws.occurrences.find((o) => o.sourceType === "event" && o.sourceId === record.id && o.originalDate === occDate);
        if (!match) {
          out.push({ id, name, ok: false, msg: `No ${fmtDay(occDate, ev.precision)} occurrence of this event applies to this client — skipped.` });
          setResults([...out]);
          continue;
        }
        if (match.excluded) {
          out.push({ id, name, ok: false, msg: "This occurrence is excluded for this client (customer override) — skipped." });
          setResults([...out]);
          continue;
        }
        const dueDate = match.outreachDate;
        await saveRaw({
          kind: "followup",
          followup: {
            customerId: id, contactId: null, title: ev.title, dueDate, status: "needs_contact", owner: ev.owner,
            notes: ev.merchandise ? `Merchandise: ${ev.merchandise}` : "", sourceType: "event", sourceId: record.id, occurrenceDate: occDate, invoiceIds: [],
          },
        });
        out.push({ id, name, ok: true });
      } catch (err) {
        out.push({ id, name, ok: false, msg: errorInfo(err).message });
      }
      setResults([...out]);
    }
    invalidate();
    setSelected(new Map(out.filter((r) => !r.ok).map((r) => [r.id, r.name])));
    setRunning(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Audience · {ev.title}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-slate-400">
          Occurrence {fmtDay(occDate, ev.precision)}{occurrence ? "" : " (next upcoming)"} · default outreach from {fmtDay(defaultDue)}; client-specific date overrides and exclusions are applied per client. Select customers to create one follow-up each. Nothing is sent to customers.
        </p>
        {pastOnce && (
          <p className="text-xs text-amber-300 rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2">
            This one-time event already took place on {fmtDay(ev.startDate, ev.precision)}. Edit the event date before creating follow-ups.
          </p>
        )}
        <div className="space-y-3">
          {ev.customerIds.length > 0 && (
            <div className="rounded-lg border border-slate-800">
              <p className="px-3 py-2 border-b border-slate-800 bg-slate-900/50 text-xs font-semibold text-slate-200">Explicitly targeted clients</p>
              <div className="divide-y divide-slate-800/60">
                {ev.customerIds.map((id) => (
                  <AudienceRow key={id} row={{ id, name: customerNames.get(id) ?? id }} checked={selected.has(id)} toggle={toggle} has={existing.has(id)} />
                ))}
              </div>
            </div>
          )}
          {ev.nicheIds.map((n) => (
            <NicheBlock key={n} nicheId={n} nicheName={catName.get(n) ?? "Unknown niche"} selected={selected} toggle={toggle} existing={existing} />
          ))}
        </div>
        {results.length > 0 && (
          <div className="rounded-lg border border-slate-800 p-3 space-y-1 max-h-40 overflow-y-auto">
            <p className="text-xs font-semibold text-slate-300">
              {results.filter((r) => r.ok).length} created · {results.filter((r) => !r.ok).length} not created
            </p>
            {results.map((r) => (
              <p key={r.id} className={`text-xs flex items-center gap-1.5 ${r.ok ? "text-emerald-400" : "text-red-400"}`}>
                {r.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {r.name}{r.msg ? ` — ${r.msg}` : ""}
              </p>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-xs text-slate-500">{selected.size} selected</span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button disabled={selected.size === 0 || running || pastOnce} onClick={run} data-testid="button-create-audience-followups">
              {running ? <Loader2 size={14} className="animate-spin" /> : `Create ${selected.size} follow-up${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
