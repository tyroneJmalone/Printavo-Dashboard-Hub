import { useEffect, useState } from "react";
import { useGetPrintavoConnection, useUpdatePrintavoConnection, getGetPrintavoConnectionQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export function PrintavoConnectionCard() {
  const query = useGetPrintavoConnection({ query: { queryKey: getGetPrintavoConnectionQueryKey(), refetchOnMount: "always" } });
  const cache = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (query.data && !dirty) {
      setEmail(query.data.email);
      setExpiresOn(query.data.expiresOn || "");
    }
  }, [query.data, dirty]);
  const save = useUpdatePrintavoConnection({ mutation: {
    onSuccess: (data) => {
      setToken(""); setDirty(false);
      cache.setQueryData(getGetPrintavoConnectionQueryKey(), data);
      cache.invalidateQueries({ queryKey: getGetPrintavoConnectionQueryKey() });
      toast({ title: "Printavo connection verified and saved", description: "Hub will use these credentials for subsequent requests." });
    },
    onError: (error) => toast({ title: "Connection not saved", description: error.message, variant: "destructive" }),
  } });
  if (query.isLoading) return <p className="text-slate-400">Loading Printavo connection…</p>;
  if (query.isError) return <div role="alert" className="text-red-300">Could not load connection settings. <button onClick={() => query.refetch()} className="underline">Retry</button></div>;
  const input = "w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100 [color-scheme:dark]";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return <section className="max-w-2xl rounded-xl border border-slate-700 bg-slate-800/50 p-6 space-y-5">
    <div><h2 className="text-xl font-semibold text-white">Printavo connection</h2>
      <p className="mt-2 text-sm text-slate-400">Replace an expiring API token without changing server settings. Credentials are checked with a read-only request before saving.</p></div>
    <p className="text-sm text-slate-300">{query.data?.environment} · {query.data?.configured ? "Credentials configured" : "Not configured"} · {query.data?.source}</p>
    {query.data?.expiresOn && <p className={query.data.expiresOn < today ? "text-amber-300 text-sm" : "text-slate-300 text-sm"}>Recorded expiration: {query.data.expiresOn}{query.data.expiresOn < today ? " — this date has passed; verify or replace the token." : ""}</p>}
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); save.mutate({ data: { email, token: token || undefined, expiresOn: expiresOn || null } }); }}>
      <fieldset disabled={save.isPending} className="space-y-4 disabled:opacity-60">
        <label className="block text-sm text-slate-300">Printavo account email<input className={`${input} mt-1`} type="email" required value={email} onChange={e => { setEmail(e.target.value); setDirty(true); }} /></label>
        <label className="block text-sm text-slate-300">New API token<input className={`${input} mt-1`} type="password" autoComplete="new-password" maxLength={4096} required={!query.data?.configured} value={token} onChange={e => { setToken(e.target.value); setDirty(true); }} placeholder="Leave blank to keep the existing token" /></label>
        <label className="block text-sm text-slate-300">Token expiration date<input className={`${input} mt-1`} type="date" value={expiresOn} onChange={e => { setExpiresOn(e.target.value); setDirty(true); }} /></label>
        <p className="text-xs text-slate-400">Enter the date shown by Printavo. This records the date; it does not renew the token or stop requests automatically. Clear the field to remove the recorded date.</p>
        <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-50">{save.isPending ? "Verifying…" : "Verify & save connection"}</button>
      </fieldset>
    </form>
    <p className="text-xs text-slate-400">The saved token is encrypted and is never displayed again. Changes apply only to this Hub environment, not other platforms. Update the published Hub separately from development preview.</p>
  </section>;
}
