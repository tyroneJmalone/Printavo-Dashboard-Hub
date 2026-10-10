import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetVendorShippingTerms, setVendorShippingTerms, getGetVendorShippingTermsQueryKey,
  type VendorShippingTerms } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { shippingProgress, type ShippingPricedItem } from "./shippingProgress";

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
type Vendor = "sanmar" | "ss";
const label = (vendor: Vendor) => vendor === "sanmar" ? "SanMar" : "S&S";
const inputClass = "w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white";

export function VendorShippingProgress({ items, selected }: { items: ShippingPricedItem[]; selected: Set<string> }) {
  return <div className="grid gap-3 md:grid-cols-2">
    {(["sanmar", "ss"] as const).map(vendor =>
      <VendorProgress key={vendor} vendor={vendor} items={items} selected={selected} />)}
  </div>;
}

function VendorProgress({ vendor, items, selected }: { vendor: Vendor; items: ShippingPricedItem[]; selected: Set<string> }) {
  const query = useGetVendorShippingTerms(vendor, { query: {
    queryKey: getGetVendorShippingTermsQueryKey(vendor), staleTime: 0, refetchInterval: 60000,
  } });
  const [editing, setEditing] = useState(false);
  const terms = query.data?.terms ?? null;
  const result = shippingProgress(items, selected, vendor, terms);
  const hasSelection = items.some(item => selected.has(item.key) && item.vendor === vendor);
  return <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300" data-testid={`shipping-progress-${vendor}`}>
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-semibold text-white">{label(vendor)} free-shipping estimate</h3>
      <button className="text-emerald-400 underline disabled:opacity-50" disabled={query.isLoading || query.isError}
        onClick={() => setEditing(true)}>{terms ? "Edit terms" : "Configure terms"}</button>
    </div>
    {query.isLoading ? <p>Loading account terms…</p> : query.isError
      ? <p role="alert">Could not load account terms. <button className="underline" onClick={() => query.refetch()}>Retry</button></p>
      : !terms ? <p>Shipping terms not configured. No threshold assumed; confirm this account’s terms first.</p>
      : <div className="mt-2 space-y-1">
        <p>{terms.accountLabel} · {money(terms.threshold)} {terms.scope === "warehouse" ? "per warehouse" : "per order"}</p>
        <p>Account confirmation: {terms.verifiedOn} · Review by {terms.validThrough}</p>
        <p className="break-words">Source: {terms.evidence}</p>
        <p>Excluded brands: {terms.excludedBrands.join(", ") || "None recorded"} · Excluded styles: {terms.excludedStyles.join(", ") || "None recorded"}</p>
        {!hasSelection ? <p>Select lines assigned to {label(vendor)} to estimate progress.</p> : result && <>
          <p>{money(result.amount)} selected qualifying spend{result.incomplete ? " (known portion only)" : ""} · {result.excludedLines} excluded lines</p>
          {terms.scope === "order" && !result.expired && <>
            <progress className="w-full h-2 accent-emerald-500" max={100} value={result.percent} aria-label={`${label(vendor)} threshold progress`} />
            <p>{result.remaining > 0 ? `${money(result.remaining)} remaining${result.incomplete ? " based on known prices only" : ""}.`
              : result.estimatedEligible ? "Estimated eligible for the recorded terms — not guaranteed."
              : "Known spend reaches the threshold; eligibility is not verified."}</p>
          </>}
          {result.blockers.map(text => <p key={text} className="text-amber-300">{text}</p>)}
        </>}
        <p className="text-slate-400">Assumes selected lines become one purchase for this account. Splitting purchases requires recalculation. Vendor confirmation controls final shipping charges; tax, freight and surcharges do not count.</p>
      </div>}
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{label(vendor)} account shipping terms</DialogTitle>
          <DialogDescription>Record confirmed account terms, not public promotional thresholds. This never places an order.</DialogDescription></DialogHeader>
        {editing && <TermsEditor vendor={vendor} terms={terms} close={() => setEditing(false)} />}
      </DialogContent>
    </Dialog>
  </section>;
}

function TermsEditor({ vendor, terms, close }: { vendor: Vendor; terms: VendorShippingTerms | null; close: () => void }) {
  const client = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(form: HTMLFormElement, clear = false) {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const list = (key: string) => text(key).split("\n").map(s => s.trim()).filter(Boolean);
    const threshold = text("threshold");
    if (!confirmed || (!clear && (!threshold || !form.reportValidity()))) return;
    setSaving(true); setError("");
    try {
      await setVendorShippingTerms(vendor, {
        adminPin: text("adminPin"), confirmed,
        terms: clear ? null : {
          accountLabel: text("accountLabel"), threshold: Number(threshold),
          scope: text("scope") as VendorShippingTerms["scope"], shippingMethod: text("shippingMethod"),
          excludedBrands: list("excludedBrands"), excludedStyles: list("excludedStyles"),
          otherConditions: text("otherConditions"), evidence: text("evidence"),
          verifiedOn: text("verifiedOn"), validThrough: text("validThrough"),
        },
      });
      await client.invalidateQueries({ queryKey: getGetVendorShippingTermsQueryKey(vendor) });
      close();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save terms"); }
    finally { setSaving(false); }
  }
  return <form onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }} className="space-y-3 text-sm">
    <p>Use a non-sensitive account label. If the purchasing account changes, clear or re-confirm these terms. Leave method and other conditions blank only when confirmed unrestricted.</p>
    <label className="block">Account label<input className={inputClass} name="accountLabel" required maxLength={120} defaultValue={terms?.accountLabel} /></label>
    <label className="block">Qualifying merchandise threshold (USD)<input className={inputClass} name="threshold" type="number" min={0} max={1000000} step="0.01" required defaultValue={terms?.threshold} /></label>
    <label className="block">Threshold applies to<select className={inputClass} name="scope" required defaultValue={terms?.scope ?? ""}>
      <option value="" disabled>Confirm scope…</option><option value="order">Whole order, including warehouse splits</option><option value="warehouse">Each warehouse shipment separately</option>
    </select></label>
    <label className="block">Required shipping method (blank = no restriction)<input className={inputClass} name="shippingMethod" maxLength={200} defaultValue={terms?.shippingMethod} /></label>
    <label className="block">Excluded brands (exact names, one per line)<textarea className={inputClass} name="excludedBrands" defaultValue={terms?.excludedBrands.join("\n")} /></label>
    <label className="block">Excluded styles (exact vendor style numbers, one per line)<textarea className={inputClass} name="excludedStyles" defaultValue={terms?.excludedStyles.join("\n")} /></label>
    <label className="block">Other restrictions (destination, drop-ship, sale goods, exceptions)<textarea className={inputClass} name="otherConditions" maxLength={2000} defaultValue={terms?.otherConditions} /></label>
    <p className="text-xs text-slate-400">Free-text restrictions and warehouse/method rules remain review-required. They are never silently treated as satisfied.</p>
    <label className="block">Account confirmation source (rep/email/policy reference; no credentials)<textarea className={inputClass} name="evidence" required maxLength={2000} defaultValue={terms?.evidence} /></label>
    <div className="grid grid-cols-2 gap-3">
      <label>Confirmed on<input className={inputClass} name="verifiedOn" type="date" required defaultValue={terms?.verifiedOn} /></label>
      <label>Valid through / review by<input className={inputClass} name="validThrough" type="date" required defaultValue={terms?.validThrough} /></label>
    </div>
    <label className="block">Admin PIN<input className={inputClass} name="adminPin" type="password" autoComplete="off" required /></label>
    <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
      I confirmed these terms and exclusions for the connected vendor account, or intend to clear them.</label>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex gap-3">
      <button type="submit" disabled={saving || !confirmed} className="rounded bg-emerald-600 px-3 py-2 disabled:opacity-50">{saving ? "Saving…" : "Save confirmed terms"}</button>
      {terms && <button type="button" disabled={saving || !confirmed} className="underline disabled:opacity-50"
        onClick={e => { const form = e.currentTarget.form; if (form) void save(form, true); }}>Clear terms</button>}
      <button type="button" disabled={saving} onClick={close}>Cancel</button>
    </div>
  </form>;
}
