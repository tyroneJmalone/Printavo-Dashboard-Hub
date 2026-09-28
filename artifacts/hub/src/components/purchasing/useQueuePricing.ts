import { useEffect, useRef, useState } from "react";
import { vendorLookup, type VendorLookupResult } from "@workspace/api-client-react";
import type { CartItem } from "../../stores/poCart";
import { createQueueLookup, freshLookup, isCurrentPricingRequest, priceQueueItem, pricingContext, shouldAutoPrice, type QueueApproval } from "./queuePricing";
import { getApprovedPurchasingMapping, saveApprovedPurchasingMapping } from "./approvedMappings";

type Quote = { context: string; result?: VendorLookupResult; error?: string; pending?: boolean; approval?: QueueApproval; picked?: { vendorStyle: string; brand: string | null } };
const mappingContext = (item: CartItem) => ({
  vendor: item.vendor as "sanmar" | "ss", sourceStyle: item.styleNumber,
  sourceBrand: item.brand ?? "", sourceColor: item.color ?? "",
});

/** Session-local, read-only estimates. Never inserts into cart or submits orders. */
export function useQueuePricing(items: CartItem[]) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [, tick] = useState(0);
  const live = useRef(items);
  live.current = items;
  const versions = useRef(new Map<string, number>());
  const dispatcher = useRef<ReturnType<typeof createQueueLookup> | null>(null);
  if (!dispatcher.current) dispatcher.current = createQueueLookup(vendorLookup);
  const attempted = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => tick(n => n + 1), 30000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);

  async function price(item: CartItem, refresh = false, picked?: { vendorStyle: string; brand: string | null }) {
    const context = pricingContext(item);
    attempted.current.set(item.key, context);
    const version = (versions.current.get(item.key) ?? 0) + 1;
    versions.current.set(item.key, version);
    const current = () => mounted.current &&
      isCurrentPricingRequest(item, live.current, version, versions.current.get(item.key));
    setQuotes(q => ({ ...q, [item.key]: { context, pending: true } }));
    try {
      if (item.vendor !== "sanmar" && item.vendor !== "ss") throw new Error("Choose a source vendor first.");
      let approval: QueueApproval | undefined;
      let warning: string | undefined;
      try {
        if (!picked) approval = await getApprovedPurchasingMapping(mappingContext(item)) ?? undefined;
      } catch {
        warning = "Saved match could not be loaded. Retry pricing or approve a match manually.";
      }
      const selection = picked ?? approval;
      const lookupItem = selection ? { ...item, styleNumber: selection.vendorStyle, brand: picked?.brand ?? null } : item;
      if (!lookupItem.styleNumber.trim()) throw new Error("Style number is required — search for a replacement.");
      const result = await dispatcher.current!(lookupItem, refresh, current);
      if (current()) setQuotes(q => ({ ...q, [item.key]: { context, result, approval, picked, error: warning } }));
    } catch (error) {
      if (current()) setQuotes(q => ({ ...q, [item.key]: {
        context, error: error instanceof Error ? error.message : "Vendor pricing failed.",
      } }));
    }
  }

  async function approve(item: CartItem, vendorColor: string) {
    const quote = quotes[item.key];
    if (!quote?.result || quote.context !== pricingContext(item)) throw new Error("Get current prices before approving.");
    const approval: QueueApproval = { vendorColor, vendorStyleId: quote.result.styleId,
      vendorStyle: quote.picked?.vendorStyle ?? quote.result.styleName ?? item.styleNumber };
    // Only an explicit style pick may override a conflicting/closest product.
    priceQueueItem({ ...item, brand: quote.picked ? quote.picked.brand : item.brand, color: vendorColor }, quote.result);
    priceQueueItem(item, quote.result, Date.now(), approval);
    await saveApprovedPurchasingMapping({ ...mappingContext(item), ...approval });
    if (live.current.some(i => i.key === item.key && pricingContext(i) === quote.context)) {
      setQuotes(q => q[item.key] === quote ? { ...q, [item.key]: { ...quote, approval, error: undefined } } : q);
    }
  }

  function result(item: CartItem) {
    const quote = quotes[item.key];
    return quote?.context === pricingContext(item) && !quote.pending ? quote.result : undefined;
  }

  // Preload reliable saved/explicit sources, then reprice changed inputs.
  // Unassigned suggestions never trigger lookups. Failed contexts wait for
  // manual retry or an actual input change; the dispatcher bounds all traffic.
  const inputsContext = JSON.stringify(items.map(pricingContext));
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const item of live.current) {
        if (shouldAutoPrice(item, attempted.current.get(item.key))) void price(item);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [inputsContext]);

  function read(item: CartItem): { item: CartItem; message: string } {
    const quote = quotes[item.key];
    if (!quote || quote.context !== pricingContext(item)) return { item, message: "Not priced" };
    if (quote.pending) return { item, message: "Getting prices…" };
    if (quote.error) return { item, message: quote.error };
    if (!quote.result || !freshLookup(quote.result)) return { item, message: "Price expired — refresh" };
    try {
      if (quote.picked && !quote.approval) return { item, message: "Replacement selected — choose and approve its vendor color." };
      return { item: priceQueueItem(item, quote.result, Date.now(), quote.approval), message: `Estimate · ${quote.approval ? "approved match · " : ""}${quote.result.cached ? "cached · " : ""}${new Date(quote.result.fetchedAt).toLocaleTimeString()}` };
    } catch (error) {
      return { item, message: error instanceof Error ? error.message : "Price unavailable" };
    }
  }
  return { read, price, result, approve,
    chooseStyle: (item: CartItem, vendorStyle: string, brand: string | null) => price(item, false, { vendorStyle, brand }) };
}