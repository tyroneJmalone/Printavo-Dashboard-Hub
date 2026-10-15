import { useMemo, useState } from "react";
import {
  useGetSalesWorkspace,
  getGetSalesWorkspaceQueryKey,
  useListCustomerCategories,
  getListCustomerCategoriesQueryKey,
  type SalesEventRecord,
  type SalesFollowup,
  type SalesFollowupRecord,
  type SalesOccurrence,
} from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { useStaff } from "@/components/auth/StaffGate";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarClock, Loader2, Plus, Users } from "lucide-react";
import { FollowupBoard } from "@/components/sales/FollowupBoard";
import { SalesCalendar } from "@/components/sales/SalesCalendar";
import { HistoryProspects, anniversaryFollowup } from "@/components/sales/HistoryProspects";
import { FieldDefinitions } from "@/components/sales/FieldDefinitions";
import { FollowupDialog } from "@/components/sales/FollowupDialog";
import { EventDialog } from "@/components/sales/EventDialog";
import { EventAudienceDialog } from "@/components/sales/EventAudienceDialog";
import { OccurrenceDialog } from "@/components/sales/OccurrenceDialog";
import { addDays, fmtDay, isoDate, todayIso, OPEN_STATUSES } from "@/components/sales/salesUtils";

export default function SalesFollowups() {
  const { role } = useStaff();
  const [tab, setTab] = useState("board");
  const [month, setMonth] = useState(() => new Date());
  const [owner, setOwner] = useState("all");
  const [niche, setNiche] = useState("all");

  const from = addDays(isoDate(new Date(month.getFullYear(), month.getMonth(), 1)), -7);
  const to = addDays(isoDate(new Date(month.getFullYear(), month.getMonth() + 1, 0)), 7);
  const params = { from, to, ...(owner !== "all" ? { owner } : {}), ...(niche !== "all" ? { nicheId: niche } : {}) };
  const { data, isLoading, isError, isFetching, refetch } = useGetSalesWorkspace(params, {
    query: { queryKey: getGetSalesWorkspaceQueryKey(params), refetchInterval: 30_000, staleTime: 0 },
  });
  const { data: catData } = useListCustomerCategories({ query: { queryKey: getListCustomerCategoriesQueryKey() } });
  const categories = catData?.categories ?? [];
  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const customerNames = useMemo(() => new Map((data?.customers ?? []).map((c) => [c.id, c.name])), [data]);
  const owners = data?.owners ?? [];
  const followups = data?.followups ?? [];
  const events = data?.events ?? [];

  const [fuOpen, setFuOpen] = useState(false);
  const [fuRecord, setFuRecord] = useState<SalesFollowupRecord | null>(null);
  const [fuInit, setFuInit] = useState<(Partial<SalesFollowup> & { customerName?: string }) | undefined>();
  const [evOpen, setEvOpen] = useState(false);
  const [evRecord, setEvRecord] = useState<SalesEventRecord | null>(null);
  const [audOpen, setAudOpen] = useState(false);
  const [audEvent, setAudEvent] = useState<SalesEventRecord | null>(null);
  const [audOcc, setAudOcc] = useState<SalesOccurrence | null>(null);
  const [occ, setOcc] = useState<SalesOccurrence | null>(null);

  const newFollowup = (init?: Partial<SalesFollowup> & { customerName?: string }) => { setFuRecord(null); setFuInit(init); setFuOpen(true); };
  const editFollowup = (r: SalesFollowupRecord) => { setFuRecord(r); setFuInit(undefined); setFuOpen(true); };
  const occEvent = occ?.sourceType === "event" ? events.find((e) => e.id === occ.sourceId) ?? null : null;

  const today = todayIso();
  const openCount = followups.filter((f) => OPEN_STATUSES.has(f.followup.status)).length;
  const overdueCount = followups.filter((f) => OPEN_STATUSES.has(f.followup.status) && f.followup.dueDate < today).length;

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-4 md:px-8 py-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <CalendarClock size={20} className="text-[#10b981]" /> Sales Follow-ups
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {openCount} open · <span className={overdueCount ? "text-red-400" : ""}>{overdueCount} overdue</span> — seasonal timing backed by real invoices. Nothing here emails customers.
            {isFetching && !isLoading && <Loader2 size={11} className="inline animate-spin ml-1.5" />}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={owner} onValueChange={setOwner}>
            <SelectTrigger className="h-9 w-48" data-testid="select-owner-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {owners.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={niche} onValueChange={setNiche}>
            <SelectTrigger className="h-9 w-48" data-testid="select-niche-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All niches</SelectItem>
              {categories.filter((c) => c.active).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => { setEvRecord(null); setEvOpen(true); }} data-testid="button-new-event"><Plus size={14} /> Event</Button>
          <Button size="sm" className="gap-1" onClick={() => newFollowup()} data-testid="button-new-followup"><Plus size={14} /> Follow-up</Button>
        </div>
      </div>

      <div className="px-4 md:px-8 py-5">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-5 h-auto max-w-full flex-wrap justify-start">
            <TabsTrigger value="board" data-testid="tab-board">Board</TabsTrigger>
            <TabsTrigger value="calendar" data-testid="tab-calendar">Calendar</TabsTrigger>
            <TabsTrigger value="events" data-testid="tab-events">Events</TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">History prospects</TabsTrigger>
            {role === "admin" && <TabsTrigger value="fields" data-testid="tab-fields">Fields</TabsTrigger>}
          </TabsList>

          {tab !== "history" && (isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-64 rounded-xl bg-slate-900/60 animate-pulse" />)}</div>
          ) : isError || !data ? (
            <div className="rounded-xl border border-red-900/50 bg-red-950/20 px-4 py-8 text-center">
              <p className="text-sm text-red-300">Could not load the sales workspace.</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>Retry</Button>
            </div>
          ) : null)}

          {data && (
            <>
              <TabsContent value="board">
                <FollowupBoard followups={followups} customerNames={customerNames} onEdit={editFollowup} />
              </TabsContent>
              <TabsContent value="calendar">
                <SalesCalendar
                  month={month} setMonth={setMonth} occurrences={data.occurrences} followups={followups} customerNames={customerNames}
                  owner={owner !== "all" ? owner : undefined} nicheId={niche !== "all" ? niche : undefined}
                  onOccurrence={setOcc} onFollowup={editFollowup}
                  onAnniversary={(p, d) => newFollowup(anniversaryFollowup(p, d, owner !== "all" ? owner : ""))}
                />
              </TabsContent>
              <TabsContent value="events">
                {events.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-800 px-6 py-14 text-center">
                    <p className="text-slate-300 font-medium">No seasonal events yet</p>
                    <p className="text-xs text-slate-500 mt-1">Add events like school kickoff or league registration, targeted to niches or specific clients.</p>
                    <Button size="sm" className="mt-4 gap-1" onClick={() => { setEvRecord(null); setEvOpen(true); }}><Plus size={14} /> New event</Button>
                  </div>
                ) : (
                  <div className="border border-slate-800 rounded-xl overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
                          <th className="px-4 py-2.5 text-left">Event</th>
                          <th className="px-4 py-2.5 text-left">When</th>
                          <th className="px-4 py-2.5 text-left">Audience</th>
                          <th className="px-4 py-2.5 text-left">Owner</th>
                          <th className="px-4 py-2.5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {events.map((r) => (
                          <tr key={r.id} className="hover:bg-slate-900/40" data-testid={`row-event-${r.id}`}>
                            <td className="px-4 py-2.5">
                              <p className="text-slate-100 font-medium">{r.event.title}</p>
                              {r.event.merchandise && <p className="text-[11px] text-slate-500">{r.event.merchandise}</p>}
                            </td>
                            <td className="px-4 py-2.5 text-slate-300 text-xs whitespace-nowrap">
                              {fmtDay(r.event.startDate, r.event.precision)}{r.event.endDate ? ` – ${fmtDay(r.event.endDate, r.event.precision)}` : ""}
                              <span className="block text-slate-500">{r.event.recurrence === "annual" ? "Every year" : "Once"} · {r.event.leadDays}d lead</span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                {r.event.nicheIds.map((n) => <span key={n} className="text-[10px] rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-300">{catName.get(n) ?? "Niche"}</span>)}
                                {r.event.customerIds.map((c) => <span key={c} className="text-[10px] rounded border border-slate-700 px-1.5 py-0.5 text-slate-300">{customerNames.get(c) ?? c}</span>)}
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-400">{r.event.owner || "—"}</td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={() => { setAudEvent(r); setAudOcc(data.occurrences.find((o) => o.sourceType === "event" && o.sourceId === r.id) ?? null); setAudOpen(true); }} data-testid={`button-audience-${r.id}`}><Users size={13} /> Audience</Button>
                              <Button size="sm" variant="ghost" className="h-7" onClick={() => { setEvRecord(r); setEvOpen(true); }}>Edit</Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>
              {role === "admin" && <TabsContent value="fields"><FieldDefinitions fields={data.fields} /></TabsContent>}
            </>
          )}
          <TabsContent value="history">
            <HistoryProspects owner={owner !== "all" ? owner : undefined} nicheId={niche !== "all" ? niche : undefined} followups={followups} onCreate={newFollowup} />
          </TabsContent>
        </Tabs>
      </div>

      <FollowupDialog open={fuOpen} onOpenChange={setFuOpen} record={fuRecord} initial={fuInit} customerNames={customerNames} owners={owners} />
      <EventDialog open={evOpen} onOpenChange={setEvOpen} record={evRecord} customerNames={customerNames} owners={owners} />
      <EventAudienceDialog open={audOpen} onOpenChange={setAudOpen} record={audEvent} occurrence={audOcc} customerNames={customerNames} followups={followups} />
      <OccurrenceDialog
        occurrence={occ}
        onOpenChange={(o) => !o && setOcc(null)}
        event={occEvent}
        customerNames={customerNames}
        onAudience={() => { setAudEvent(occEvent); setAudOcc(occ); setOcc(null); setAudOpen(true); }}
        onEditEvent={() => { setEvRecord(occEvent); setOcc(null); setEvOpen(true); }}
        onFollowup={(init) => { setOcc(null); newFollowup(init); }}
      />
    </AppShell>
  );
}
