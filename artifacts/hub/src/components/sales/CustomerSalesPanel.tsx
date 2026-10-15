import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetSalesWorkspace,
  getGetSalesWorkspaceQueryKey,
  type SalesEventRecord,
  type SalesFieldRecord,
  type SalesFollowup,
  type SalesFollowupRecord,
  type SalesOccurrence,
  type SalesValueRecord,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarClock, Lock, Plus, AlertTriangle } from "lucide-react";
import { StatusSelect } from "./FollowupBoard";
import { FollowupDialog } from "./FollowupDialog";
import { EventDialog } from "./EventDialog";
import { OccurrenceDialog } from "./OccurrenceDialog";
import { addDays, errorInfo, fmtDay, todayIso, useSalesActions } from "./salesUtils";

function ValueEditor({ field, record, customerId, contactId }: { field: SalesFieldRecord; record: SalesValueRecord | undefined; customerId: string; contactId: string | null }) {
  const { saveRaw, invalidate } = useSalesActions();
  const current = record?.value.value ?? "";
  const [v, setV] = useState(current);
  const [base, setBase] = useState({ value: current, id: record?.id, version: record?.version });
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    // A background refresh must not discard another user's in-progress input.
    if (v === base.value || current === v) {
      setV(current);
      setBase({ value: current, id: record?.id, version: record?.version });
    } else if (record?.version !== base.version || record?.id !== base.id) {
      setState("error");
      setMsg("This value changed elsewhere. Your edit is preserved; Cancel loads the latest value.");
    }
  }, [current, record?.id, record?.version]);
  const t = field.field.type;
  const dirty = v !== base.value;
  const cancel = () => {
    setV(current);
    setBase({ value: current, id: record?.id, version: record?.version });
    setState("idle");
    setMsg("");
  };
  const invalid = t === "annual_date" && v !== "" && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)
    ? "Use MM-DD, e.g. 09-15"
    : t === "number" && v !== "" && Number.isNaN(Number(v)) ? "Enter a number" : "";
  const commit = async () => {
    if (!dirty || invalid) return;
    setState("saving");
    try {
      const id = await saveRaw({ kind: "value", ...(base.id ? { id: base.id, version: base.version } : {}), value: { fieldId: field.id, customerId, contactId, value: v.trim() } });
      setV(v.trim());
      setBase({ value: v.trim(), id, version: (base.version ?? 0) + 1 });
      setState("saved");
      setMsg("");
      invalidate();
    } catch (err) {
      const info = errorInfo(err);
      if (info.conflict) invalidate();
      setState("error");
      setMsg(info.message);
    }
  };
  const tid = `input-field-${field.id}-${contactId ?? "co"}`;
  const input = t === "boolean" || t === "dropdown" ? (
    <Select value={v || "__none"} disabled={state === "saving"} onValueChange={(x) => { setV(x === "__none" ? "" : x); setState("idle"); }}>
      <SelectTrigger className="h-8" data-testid={tid}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">Not set</SelectItem>
        {(t === "boolean" ? [["true", "Yes"], ["false", "No"]] : field.field.options.map((o) => [o, o])).map(([val, l]) => <SelectItem key={val} value={val}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  ) : (
    <Input
      className={`h-8 ${dirty ? "border-amber-600" : ""}`}
      data-testid={tid}
      type={t === "date" ? "date" : "text"}
      inputMode={t === "number" ? "decimal" : undefined}
      placeholder={t === "annual_date" ? "MM-DD" : ""}
      value={v}
      disabled={state === "saving"}
      onChange={(e) => { setV(e.target.value); setState("idle"); }}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
    />
  );
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0">{input}</div>
        {dirty && (
          <>
            <Button size="sm" className="h-8 px-2" disabled={!!invalid || state === "saving"} onClick={commit} data-testid={`${tid}-save`}>Save</Button>
            <Button size="sm" variant="ghost" className="h-8 px-2" disabled={state === "saving"} onClick={cancel}>Cancel</Button>
          </>
        )}
      </div>
      {invalid ? <p className="text-[11px] text-amber-400 mt-0.5">{invalid}</p>
        : state === "error" ? <p className="text-[11px] text-red-400 mt-0.5">Not saved: {msg}</p>
        : state === "saving" ? <p className="text-[11px] text-slate-500 mt-0.5">Saving…</p>
        : dirty ? <p className="text-[11px] text-amber-400 mt-0.5">Unsaved change</p>
        : state === "saved" ? <p className="text-[11px] text-emerald-400 mt-0.5">Saved</p> : null}
    </div>
  );
}

export function CustomerSalesPanel({ customerId, customerName }: { customerId: string; customerName: string }) {
  const today = todayIso();
  const params = { from: addDays(today, -30), to: addDays(today, 365), customerId };
  const { data, isLoading, isError, refetch } = useGetSalesWorkspace(params, {
    query: { queryKey: getGetSalesWorkspaceQueryKey(params), enabled: !!customerId, refetchInterval: 30_000 },
  });
  const customerNames = useMemo(() => {
    const m = new Map((data?.customers ?? []).map((c) => [c.id, c.name]));
    m.set(customerId, customerName);
    return m;
  }, [data, customerId, customerName]);

  const [fuOpen, setFuOpen] = useState(false);
  const [fuRecord, setFuRecord] = useState<SalesFollowupRecord | null>(null);
  const [fuInit, setFuInit] = useState<Partial<SalesFollowup> | undefined>();
  const [evOpen, setEvOpen] = useState(false);
  const [evRecord, setEvRecord] = useState<SalesEventRecord | null>(null);
  const [occ, setOcc] = useState<SalesOccurrence | null>(null);

  if (isLoading) return <div className="h-40 rounded-xl border border-slate-800 bg-slate-900/40 animate-pulse" />;
  if (isError || !data) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-4 text-sm text-slate-400">
        Sales follow-ups unavailable. <button className="underline text-slate-200" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }
  const owners = data.owners;
  const myFollowups = data.followups.filter((f) => f.followup.customerId === customerId).sort((a, b) => a.followup.dueDate.localeCompare(b.followup.dueDate));
  const occs = [...data.occurrences].sort((a, b) => a.date.localeCompare(b.date));
  const companyFields = data.fields.filter((f) => f.field.scope === "customer");
  const contactFields = data.fields.filter((f) => f.field.scope === "contact");
  const valueFor = (fieldId: string, contactId: string | null) => data.values.find((v) => v.value.fieldId === fieldId && (v.value.contactId ?? null) === contactId);
  const occEvent = occ?.sourceType === "event" ? data.events.find((e) => e.id === occ.sourceId) ?? null : null;
  const occOverride = occ ? data.overrides.find((o) => o.override.eventId === occ.sourceId && o.override.occurrenceDate === occ.originalDate && o.override.customerId === customerId) ?? null : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-1.5">
          <CalendarClock size={14} className="text-[#10b981]" /> Sales follow-ups
          <Link href="/customers/follow-ups" className="text-xs font-normal text-slate-500 hover:text-emerald-400">open board</Link>
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => { setEvRecord(null); setEvOpen(true); }} data-testid="button-profile-new-event"><Plus size={12} /> Client event</Button>
          <Button size="sm" className="h-7 gap-1" onClick={() => { setFuRecord(null); setFuInit({ customerId }); setFuOpen(true); }} data-testid="button-profile-new-followup"><Plus size={12} /> Follow-up</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Upcoming events</p>
          {occs.length === 0 ? <p className="text-xs text-slate-500">No events or date reminders in the next year.</p> : (
            <div className="space-y-1.5">
              {occs.map((o) => (
                <button key={o.key} onClick={() => setOcc(o)} className={`w-full text-left rounded-lg border border-slate-800 px-2.5 py-1.5 hover:border-slate-600 ${o.excluded ? "opacity-50" : ""}`} data-testid={`occurrence-${o.key}`}>
                  <p className={`text-sm text-slate-100 ${o.excluded ? "line-through" : ""}`}>{o.title}</p>
                  <p className="text-[11px] text-slate-400">{fmtDay(o.date, o.precision)} · reach out {fmtDay(o.outreachDate)}</p>
                  <p className="text-[10px] text-slate-500">
                    {o.sourceType === "custom_field" ? "Field reminder" : o.customerId == null ? "Shared seasonal/client event" : o.inherited ? "Inherited from niche" : "Client-specific"}
                    {o.originalDate !== o.date ? " · date adjusted" : ""}{o.excluded ? " · excluded" : ""}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Follow-ups</p>
          {myFollowups.length === 0 ? <p className="text-xs text-slate-500">No follow-ups for this customer.</p> : (
            <div className="space-y-1.5">
              {myFollowups.map((f) => {
                const overdue = f.followup.dueDate < today && !["dismissed", "completed"].includes(f.followup.status);
                return (
                  <div key={f.id} className="rounded-lg border border-slate-800 px-2.5 py-1.5">
                    <button className="text-left w-full" onClick={() => { setFuRecord(f); setFuOpen(true); }}>
                      <p className="text-sm text-slate-100">{f.followup.title}</p>
                      <p className={`text-[11px] inline-flex items-center gap-1 ${overdue ? "text-red-400" : "text-slate-400"}`}>{overdue && <AlertTriangle size={10} />}{fmtDay(f.followup.dueDate)}{f.followup.owner ? ` · ${f.followup.owner}` : ""}</p>
                    </button>
                    <div className="mt-1"><StatusSelect record={f} compact /></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2 inline-flex items-center gap-1"><Lock size={10} /> Internal fields</p>
          {data.fields.length === 0 ? <p className="text-xs text-slate-500">No custom fields defined. Admins add them on the follow-ups page.</p> : (
            <div className="space-y-2">
              {companyFields.map((f) => (
                <div key={f.id}><p className="text-[11px] text-slate-400 mb-0.5">{f.field.name}</p><ValueEditor field={f} record={valueFor(f.id, null)} customerId={customerId} contactId={null} /></div>
              ))}
              {contactFields.length > 0 && (data.contacts.length === 0 ? (
                <p className="text-[11px] text-slate-500">No contacts on file for contact-level fields.</p>
              ) : data.contacts.map((c) => (
                <div key={c.id} className="rounded-lg border border-slate-800 p-2 space-y-1.5">
                  <p className="text-xs font-semibold text-slate-300">{c.name}</p>
                  {contactFields.map((f) => (
                    <div key={f.id}><p className="text-[11px] text-slate-400 mb-0.5">{f.field.name}</p><ValueEditor field={f} record={valueFor(f.id, c.id)} customerId={customerId} contactId={c.id} /></div>
                  ))}
                </div>
              )))}
            </div>
          )}
        </div>
      </div>

      <FollowupDialog open={fuOpen} onOpenChange={setFuOpen} record={fuRecord} initial={fuInit} customerNames={customerNames} contacts={data.contacts} owners={owners} lockCustomer />
      <EventDialog open={evOpen} onOpenChange={setEvOpen} record={evRecord} customerNames={customerNames} owners={owners} presetCustomer={{ id: customerId, name: customerName }} />
      <OccurrenceDialog
        occurrence={occ}
        onOpenChange={(o) => !o && setOcc(null)}
        event={occEvent}
        customerNames={customerNames}
        override={occ?.sourceType === "event" ? { customerId, record: occOverride } : undefined}
        onEditEvent={() => { setEvRecord(occEvent); setOcc(null); setEvOpen(true); }}
        onFollowup={(init) => { setOcc(null); setFuRecord(null); setFuInit({ ...init, customerId }); setFuOpen(true); }}
      />
    </div>
  );
}
