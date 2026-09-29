import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStaff } from "@/components/auth/StaffGate";
import { merchRequest, stages, inputClass, buttonClass, type Opportunity, type Details, type StaffChoice, type StoreChoice } from "./client";
import { ThreadLinks } from "./ThreadLinks";

type Draft = Omit<Opportunity, "id" | "createdAt" | "updatedAt">;
const blank = (): Draft => ({ name: "", stage: stages[0], ownerId: null, nextAction: "", dueDate: null, chipplyStoreId: null, eventId: null, archived: false, details: {} });
const detailFields: { key: keyof Details; label: string; type?: string }[] = [
  { key: "status", label: "Status / planning context" }, { key: "dashboardUrl", label: "Dashboard URL", type: "url" },
  { key: "previewUrl", label: "Chipply preview URL (URL ID, not event ID)", type: "url" }, { key: "websiteUrl", label: "Website URL", type: "url" },
  { key: "launchDate", label: "Launch date", type: "date" }, { key: "closeDate", label: "Close date", type: "date" }, { key: "inHandDate", label: "In-hand date", type: "date" },
  { key: "payee", label: "Fundraiser payee" }, { key: "processes", label: "Processes" }, { key: "audience", label: "Audience" },
  { key: "mailingAddress", label: "Payout mailing address" }, { key: "checkDate", label: "Check date", type: "date" },
  { key: "checkAmount", label: "Check amount", type: "number" }, { key: "payoutNotes", label: "Payout notes" }, { key: "notes", label: "Notes" },
];
export function MerchPipeline() {
  const { email } = useStaff();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["merch-opportunities"], queryFn: () => merchRequest<Opportunity[]>("/merch-pipeline/opportunities") });
  const staff = useQuery({ queryKey: ["merch-staff"], queryFn: () => merchRequest<StaffChoice[]>("/merch-pipeline/staff") });
  const [stage, setStage] = useState("");
  const [query, setQuery] = useState("");
  const [owned, setOwned] = useState(false);
  const [queue, setQueue] = useState("all");
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [storeSearch, setStoreSearch] = useState("");
  const stores = useQuery({ queryKey: ["merch-stores", storeSearch], enabled: editing !== null, queryFn: () => merchRequest<StoreChoice[]>(`/merch-pipeline/stores?q=${encodeURIComponent(storeSearch)}`) });
  const today = new Date().toLocaleDateString("en-CA");
  const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 7);
  const upcoming = nextWeek.toLocaleDateString("en-CA");
  const myId = staff.data?.find(s => s.email === email)?.id;
  const rows = (list.data ?? []).filter(o => o.archived === archived && (!stage || o.stage === stage) && (!owned || o.ownerId === myId) && (!query || `${o.name} ${o.eventId ?? ""} ${o.nextAction}`.toLowerCase().includes(query.toLowerCase())) && (queue === "all" || (o.stage !== "Closed" && o.dueDate && (queue === "overdue" ? o.dueDate < today : queue === "today" ? o.dueDate === today : o.dueDate > today && o.dueDate <= upcoming))));
  function edit(o?: Opportunity) {
    setError(""); setStoreSearch("");
    setEditing(o?.id ?? "new");
    setDraft(o ? { name: o.name, stage: o.stage, ownerId: o.ownerId, nextAction: o.nextAction, dueDate: o.dueDate, chipplyStoreId: o.chipplyStoreId, eventId: o.eventId, archived: o.archived, details: o.details } : blank());
  }
  async function save() {
    setError(""); setBusy(true);
    try {
      const item = await merchRequest<Opportunity>(`/merch-pipeline/opportunities${editing === "new" ? "" : `/${editing}`}`, editing === "new" ? "POST" : "PATCH", draft);
      await qc.invalidateQueries({ queryKey: ["merch-opportunities"] });
      setEditing(item.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save opportunity"); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm("Permanently delete this archived, unlinked opportunity? This cannot be undone.")) return;
    setBusy(true); setError("");
    try { await merchRequest(`/merch-pipeline/opportunities/${editing}`, "DELETE", { confirmed: true }); setEditing(null); await qc.invalidateQueries({ queryKey: ["merch-opportunities"] }); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to delete"); } finally { setBusy(false); }
  }
  return <div className="p-6 space-y-5 text-slate-200 overflow-auto">
    <div className="flex justify-between gap-4"><div><h1 className="text-xl font-bold">Merch pipeline</h1><p className="text-sm text-slate-400 mt-1">From first conversation to closed store. No customer email or store required.</p></div><button className={`${buttonClass} bg-emerald-800`} onClick={() => edit()}>New opportunity</button></div>
    <div className="flex flex-wrap gap-3 items-center">
      <input className={`${inputClass} max-w-xs`} placeholder="Search opportunities or events" aria-label="Search opportunities" value={query} onChange={e => setQuery(e.target.value)} />
      <select aria-label="Stage filter" className={`${inputClass} max-w-xs`} value={stage} onChange={e => setStage(e.target.value)}><option value="">All stages</option>{stages.map(s => <option key={s}>{s}</option>)}</select>
      <select aria-label="Follow-up queue" className={`${inputClass} max-w-xs`} value={queue} onChange={e => setQueue(e.target.value)}><option value="all">All follow-ups</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="upcoming">Upcoming 7 days</option></select>
      <label className="text-sm"><input type="checkbox" checked={owned} onChange={e => setOwned(e.target.checked)} /> Owned by me</label>
      <label className="text-sm"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> Archived</label>
    </div>
    {(list.error || staff.error) && <p role="alert" className="text-red-400">{String(list.error || staff.error)}</p>}
    <p className="text-xs text-slate-500">Follow-ups stay here—no automated emails or shared moMINTum tasks.</p>
    <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-sm text-left"><thead className="bg-slate-900 text-slate-400"><tr>{["Opportunity", "Stage", "Owner", "Next action", "Due", "Store / event"].map(h => <th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(o => <tr key={o.id} className="border-t border-slate-800 hover:bg-slate-900"><td className="p-3"><button className="text-emerald-400 text-left font-medium" onClick={() => edit(o)}>{o.name}</button></td><td className="p-3">{o.stage}</td><td className="p-3">{staff.data?.find(s => s.id === o.ownerId)?.email ?? "Unassigned"}</td><td className="p-3">{o.nextAction || "—"}</td><td className={`p-3 ${o.dueDate && o.dueDate < today && o.stage !== "Closed" ? "text-amber-400" : ""}`}>{o.dueDate ?? "—"}</td><td className="p-3">{o.chipplyStoreId ? <a className="text-emerald-400 underline" href={`/chipply/${o.chipplyStoreId}`}>Linked store</a> : "Prelaunch"}{o.eventId && ` · ${o.eventId}`}</td></tr>)}</tbody></table>
      {list.isLoading ? <p className="p-6">Loading opportunities…</p> : !rows.length && <p className="p-6 text-slate-500">No opportunities match. Create one or adjust your filters.</p>}
    </div>
    {editing !== null && <div className="fixed inset-0 z-50 bg-black/70 flex justify-end" role="dialog" aria-modal="true" aria-label="Merch opportunity editor"><div className="w-full max-w-3xl bg-slate-950 border-l border-slate-700 p-6 overflow-y-auto space-y-5">
      <div className="flex justify-between"><h2 className="text-lg font-semibold">{editing === "new" ? "New opportunity" : "Edit opportunity"}</h2><button className={buttonClass} onClick={() => setEditing(null)}>Close</button></div>
      {editing !== "new" && <p className="text-xs text-slate-500">Opportunity ID: {editing} — retained through store launch.</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label className="block text-sm">Opportunity name<input className={inputClass} required maxLength={300} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="text-sm">Stage<select className={inputClass} value={draft.stage} onChange={e => setDraft({ ...draft, stage: e.target.value as Draft["stage"] })}>{stages.map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="text-sm">Owner<select className={inputClass} value={draft.ownerId ?? ""} onChange={e => setDraft({ ...draft, ownerId: e.target.value || null })}><option value="">Unassigned</option>{staff.data?.map(s => <option key={s.id} value={s.id}>{s.email}</option>)}</select></label>
          <label className="text-sm">Next action<input className={inputClass} maxLength={2000} value={draft.nextAction} onChange={e => setDraft({ ...draft, nextAction: e.target.value })} /></label>
          <label className="text-sm">Follow-up due<input type="date" className={inputClass} value={draft.dueDate ?? ""} onChange={e => setDraft({ ...draft, dueDate: e.target.value || null })} /></label>
        </div>
        <fieldset className="rounded-lg border border-slate-800 p-3 space-y-2"><legend className="text-sm">Optional store association</legend>
          <input aria-label="Find existing store" className={inputClass} placeholder="Find existing stores by name or event ID" value={storeSearch} onChange={e => setStoreSearch(e.target.value)} />
          {stores.error && <p role="alert" className="text-red-400">{String(stores.error)}</p>}
          <select aria-label="Existing Chipply store" className={inputClass} value={draft.chipplyStoreId ?? ""} onChange={e => setDraft({ ...draft, chipplyStoreId: e.target.value || null })}><option value="">No store yet</option>{draft.chipplyStoreId && !stores.data?.some(s => s.id === draft.chipplyStoreId) && <option value={draft.chipplyStoreId}>Linked store · {draft.chipplyStoreId}</option>}{stores.data?.map(s => <option key={s.id} value={s.id}>{s.name}{s.eventId ? ` · event ${s.eventId}` : ""}</option>)}</select>
          <label className="block text-sm">Event ID (separate from preview URL ID)<input className={inputClass} maxLength={100} value={draft.eventId ?? ""} onChange={e => setDraft({ ...draft, eventId: e.target.value || null })} /></label>
        </fieldset>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{detailFields.map(({ key, label, type }) => <label key={key} className="text-sm">{label}{key === "notes" || key === "payoutNotes" ? <textarea className={inputClass} value={String(draft.details[key] ?? "")} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value } })} /> : <input type={type ?? "text"} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} className={inputClass} value={String(draft.details[key] ?? "")} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value || (type === "date" || type === "number" ? null : "") } })} />}</label>)}</div>
        <div className="flex flex-wrap gap-4">{(["fundraiser", "repeat", "partial", "inHouse"] as const).map(key => <label key={key} className="text-sm"><input type="checkbox" checked={!!draft.details[key]} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.checked } })} /> {key === "inHouse" ? "In-house" : key[0].toUpperCase() + key.slice(1)}</label>)}</div>
        <label className="block text-sm"><input type="checkbox" checked={draft.archived} onChange={e => setDraft({ ...draft, archived: e.target.checked })} /> Archived (uncheck to restore)</label>
        <div className="flex gap-3"><button disabled={busy} className={`${buttonClass} bg-emerald-800`}>{busy ? "Saving…" : "Save opportunity"}</button>{editing !== "new" && draft.archived && <button type="button" disabled={busy} className={`${buttonClass} text-red-400`} onClick={() => void remove()}>Delete permanently</button>}</div>
      </form>
      {editing !== "new" && <ThreadLinks opportunityId={editing} suggestedSearch={draft.eventId || draft.name} />}
    </div></div>}
  </div>;
}