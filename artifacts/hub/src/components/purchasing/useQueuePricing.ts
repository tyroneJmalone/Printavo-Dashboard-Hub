import { useEffect, useRef, useState } from "react";
import { vendorLookup, type VendorLookupResult } from "@workspace/api-client-react";
import type { CartItem } from "../../stores/poCart";
import { createQueueLookup, freshLookup, isCurrentPricingRequest, priceQueueItem, pricingContext, shouldAutoPrice } from "./queuePricing";

type Quote = { context: string; result?: VendorLookupResult; error?: string; pending?: boolean };

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

  async function price(item: CartItem, refresh = false) {
    const context = pricingContext(item);
    attempted.current.set(item.key, context);
    const version = (versions.current.get(item.key) ?? 0) + 1;
    versions.current.set(item.key, version);
    const current = () => mounted.current &&
      isCurrentPricingRequest(item, live.current, version, versions.current.get(item.key));
    setQuotes(q => ({ ...q, [item.key]: { context, pending: true } }));
    try {
      if (item.vendor !== "sanmar" && item.vendor !== "ss") throw new Error("Choose a source vendor first.");
      if (!item.styleNumber.trim()) throw new Error("Style number is required.");
      const result = await dispatcher.current!(item, refresh, current);
      priceQueueItem(item, result); // Fail closed on suggestions/ambiguous identity.
      if (current()) setQuotes(q => ({ ...q, [item.key]: { context, result } }));
    } catch (error) {
      if (current()) setQuotes(q => ({ ...q, [item.key]: {
        context, error: error instanceof Error ? error.message : "Vendor pricing failed.",
      } }));
    }
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
      return { item: priceQueueItem(item, quote.result), message: `Estimate · ${quote.result.cached ? "cached · " : ""}${new Date(quote.result.fetchedAt).toLocaleTimeString()}` };
    } catch (error) {
      return { item, message: error instanceof Error ? error.message : "Price unavailable" };
    }
  }
  return { read, price };
}