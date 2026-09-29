import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { merchRequest, inputClass, buttonClass, type Thread, type ThreadLink } from "./client";

export function ThreadLinks({ opportunityId, storeId, suggestedSearch = "" }: { opportunityId?: string; storeId?: string; suggestedSearch?: string }) {
  const base = opportunityId ? `/merch-pipeline/opportunities/${opportunityId}/threads` : `/chipply/stores/${storeId}/threads`;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState(suggestedSearch);
  const [submitted, setSubmitted] = useState(suggestedSearch.trim().slice(0, 300));
  const [manualUrl, setManualUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const links = useQuery({ queryKey: [base], queryFn: () => merchRequest<{ links: ThreadLink[] }>(base) });
  const suggestions = useQuery({ queryKey: [base, "search", submitted], enabled: submitted.length >= 2, queryFn: () => merchRequest<{ suggestions: Thread[] }>(`${base}?search=${encodeURIComponent(submitted)}`) });
  async function mutate(method: string, path: string, body: object) {
    if (!window.confirm(method === "DELETE" ? "Remove this correspondence link? This does not delete the conversation." : "Confirm this conversation belongs to this store/opportunity? This is a shared team association. An unknown manual URL will be visible to teammates; no message content is ingested and no mailbox access is granted.")) return;
    setBusy(true); setError("");
    try {
      await merchRequest(path, method, { ...body, confirmed: true });
      setManualUrl("");
      await queryClient.invalidateQueries({ queryKey: [base] });
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update correspondence link"); }
    finally { setBusy(false); }
  }
  return <section className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3">
    <h3 className="font-semibold text-slate-100">Store correspondence</h3>
    <p className="text-xs text-slate-400">Only conversations you can read are shown. Name/event matches are suggestions—not proof. Customer-wide matches are not linked automatically.</p>
    {(error || links.error || suggestions.error) && <p role="alert" className="text-sm text-red-400">{error || String(links.error || suggestions.error)}</p>}
    {links.isLoading ? <p>Loading authorized links…</p> : links.data?.links.length === 0 ? <p className="text-sm text-slate-500">No accessible linked conversations.</p> : links.data?.links.map(link => <div key={link.id} className="flex items-center justify-between gap-3 text-sm">
      {link.url && /^https:\/\/(mail|app)\.missiveapp\.com\//.test(link.url) ? <a className="text-emerald-400 underline" href={link.url} target="_blank" rel="noreferrer">{link.subject || "Conversation"} ↗</a> : <span>{link.subject || "Conversation"}</span>}
      <button className={buttonClass} disabled={busy} onClick={() => void mutate("DELETE", `${base}/${link.id}`, {})}>Unlink</button>
    </div>)}
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setSubmitted(search.trim()); }}>
      <input aria-label="Search authorized correspondence" className={inputClass} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by store name or event ID" minLength={2} maxLength={300} />
      <button className={buttonClass} disabled={search.trim().length < 2}>Search</button>
    </form>
    {suggestions.isFetching && <p className="text-sm">Searching authorized correspondence…</p>}
    {suggestions.data?.suggestions.length === 0 && <p className="text-sm text-slate-500">No authorized matches.</p>}
    {suggestions.data?.suggestions.map(thread => <div key={thread.id} className="flex items-center justify-between gap-3 text-sm"><span>{thread.subject || "(No subject)"}</span><button className={buttonClass} disabled={busy} onClick={() => void mutate("POST", base, { threadId: thread.id })}>Confirm link</button></div>)}
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void mutate("POST", base, { manualUrl }); }}>
      <input aria-label="Direct Missive thread URL" type="url" className={inputClass} value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder="Direct Missive URL (optional, no mail ingestion)" required />
      <button className={buttonClass} disabled={busy || !manualUrl}>Link URL</button>
    </form>
  </section>;
}