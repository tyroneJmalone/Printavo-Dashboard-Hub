import { useEffect, useRef, useState } from "react";
import { catalogSearch, type CatalogSearchHit, type VendorLookupResult } from "@workspace/api-client-react";
import type { CartItem } from "../../stores/poCart";

/** Explicit merchandise approval, separate from loose catalog color-family suggestions. */
export function QueueMatchReview({ item, result, unresolved = true, onStyle, onApprove }: {
  item: CartItem;
  result?: VendorLookupResult;
  unresolved?: boolean;
  onStyle: (item: CartItem, style: string, brand: string | null) => Promise<void>;
  onApprove: (item: CartItem, color: string) => Promise<void>;
}) {
  const [query, setQuery] = useState(item.styleNumber);
  const [hits, setHits] = useState<CatalogSearchHit[]>([]);
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setColor(""); }, [result]);
  if (item.vendor !== "ss" && item.vendor !== "sanmar") return null;
  const vendor = item.vendor;
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); }
    catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "Match operation failed."); }
    finally { if (alive.current) setBusy(false); }
  }
  return <details className="pt-1" open={unresolved || undefined}>
    <summary data-testid={`review-match-${item.key}`} className="cursor-pointer text-sky-300">Search {vendor === "ss" ? "S&S" : "SanMar"} style / review color</summary>
    <div className="space-y-2 pt-2">
      <div className="text-amber-300">Approve only the exact merchandise intended. Saves a reusable match; Printavo is unchanged.</div>
      <input data-testid={`search-vendor-style-${item.key}`} aria-label="Search vendor catalog"
        className="w-full bg-slate-900 border border-slate-700 rounded p-1" value={query}
        onChange={e => setQuery(e.target.value)} />
      <button type="button" data-testid={`search-vendor-${item.key}`} disabled={busy || !query.trim()}
        onClick={() => void run(async () => {
          const response = await catalogSearch({ q: query.trim(), vendor, limit: 15 });
          if (alive.current) { setHits(response.hits); setMessage(response.hits.length ? "Select a style, then approve its color." : "No catalog styles found."); }
         })}>Search {vendor === "ss" ? "S&S" : "SanMar"} style</button>
      {hits.map(hit => <button type="button" key={hit.id} disabled={busy}
        data-testid={`choose-vendor-style-${item.key}-${hit.id}`}
        className="block text-left border border-slate-700 rounded p-2 w-full"
        onClick={() => void run(async () => {
          setColor("");
          await onStyle(item, hit.styleName, hit.brand);
        })}>
        {hit.brand} · {hit.styleName} · {hit.title} — select replacement
      </button>)}
      {result?.found && result.colors.length > 0 && <>
        <div>{result.brand} · {result.styleName} · {result.title}</div>
        <select data-testid={`vendor-color-${item.key}`} aria-label="Vendor catalog color"
          className="w-full bg-slate-900 border border-slate-700 rounded p-1"
          value={color} onChange={e => setColor(e.target.value)} disabled={busy}>
          <option value="">Choose vendor color</option>
          {result.colors.map(c => <option key={c.colorName} value={c.colorName}>{c.colorName}</option>)}
        </select>
        <button type="button" data-testid={`approve-vendor-match-${item.key}`} disabled={busy || !color}
          onClick={() => void run(async () => {
            await onApprove(item, color);
            if (alive.current) setMessage("Approved match saved for future purchases.");
          })}>{busy ? "Saving…" : "Approve & remember style / color"}</button>
      </>}
      {message && <div role="status" data-testid={`match-message-${item.key}`}>{message}</div>}
    </div>
  </details>;
}