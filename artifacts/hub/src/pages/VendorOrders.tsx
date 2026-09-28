import { useState, useMemo, useEffect } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { useGetNeedsOrdering, useListPoFiles, type NeedsOrderingOrder, type NeedsOrderingLineItem } from "@workspace/api-client-react";
import { formatNumber } from "@/lib/format";
import { usePoCart, guessVendor, type CartVendor, type CartItem } from "@/stores/poCart";
import { useQueuePricing } from "@/components/purchasing/useQueuePricing";
import { QueueMatchReview } from "@/components/purchasing/QueueMatchReview";
import { applySelectedQueueVendor, queueSourceVendor } from "@/components/purchasing/queuePricing";
import { pricingContext, purchaseTotal, savedSourceVendor, selectedPurchaseTotals } from "@/components/purchasing/queuePricing";
import { CartDrawer } from "@/components/purchasing/CartDrawer";
import { Truck, Loader2, PackageSearch, Layers, Boxes, CalendarClock, ShoppingCart, Plus, Check, AlertTriangle, Search, Filter } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkCleanupDialog, type SelectedLineItemInfo, type TargetStatus } from "@/components/purchasing/BulkCleanupDialog";
import { buildOpenPoMembership, stableLineIdentity } from "./vendorOrdersPoMembership";
import {
  buildCartItem,
  formatPrintavoCalendarDate,
  getOrderUrgency,
  sortOrdersByUrgency,
} from "./vendorOrdersHelpers";

function statusPill(name: string | null): string {
  if (!name) return "Unknown";
  const idx = name.indexOf(" - ");
  return idx >= 0 ? name.slice(idx + 3).trim() : name;
}

/** Stale-flag rule: warn (never block) when the row looks already handled. */
function staleWarning(order: NeedsOrderingOrder, li: NeedsOrderingLineItem): string | null {
  if (li.items <= 0) return "0 pieces on this line — verify in Printavo";
  const s = (order.statusName ?? "").toLowerCase();
  if (s.includes("picked up") || s.includes("complete") || s.includes("delivered")) {
    return `Order status is "${statusPill(order.statusName)}" — may already be done`;
  }
  return null;
}

export default function VendorOrders() {
  const { data, isLoading, error } = useGetNeedsOrdering();
  const { data: poData, isLoading: poDataLoading, error: poDataError } = useListPoFiles();
  const cartItems = usePoCart((s) => s.items);
  const addItem = usePoCart((s) => s.addItem);
  const removeItem = usePoCart((s) => s.removeItem);
  const [cartOpen, setCartOpen] = useState(false);
  const inCart = useMemo(() => new Set(cartItems.map((i) => i.key)), [cartItems]);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [missingStyleOnly, setMissingStyleOnly] = useState(false);
  // Keep date-based urgency current while this screen remains open across
  // Eastern midnight; the queue itself does not need to change for the cutoff
  // and sort order to change.
  const [urgencyNow, setUrgencyNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setUrgencyNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Bulk Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sourceVendors, setSourceVendors] = useState<Record<string, CartVendor | null>>({});
  const [lineEdits, setLineEdits] = useState<Record<string, {
    source: string; values: Pick<CartItem, "styleNumber" | "color" | "sizes">;
  }>>({});
  const queueItems = useMemo(() => (data?.orders ?? []).flatMap(order =>
    order.lineItems.map(line => {
      const base = buildCartItem(order, line);
      const edit = lineEdits[base.key];
      const item = edit?.source === pricingContext(base) ? { ...base, ...edit.values } : base;
      return { ...item, vendor: queueSourceVendor(item, poData?.poFiles ?? [], sourceVendors) };
    })), [data?.orders, poData?.poFiles, sourceVendors, lineEdits]);
  const editPurchaseItem = (order: NeedsOrderingOrder, line: NeedsOrderingLineItem,
    item: CartItem, changes: Partial<Pick<CartItem, "styleNumber" | "color" | "sizes">>) => {
    setLineEdits(edits => ({ ...edits, [line.id]: {
      source: pricingContext(buildCartItem(order, line)),
      values: { styleNumber: item.styleNumber, color: item.color, sizes: item.sizes, ...changes },
    } }));
  };
  const pricing = useQueuePricing(queueItems);
  const queueById = new Map(queueItems.map(item => [item.key, item]));
  const selectedSpend = selectedPurchaseTotals(queueItems.map(item => pricing.read(item).item), selectedIds);
  const purchaseMoney = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const sourceLabel = (vendor: string) => vendor === "sanmar" ? "SanMar" : vendor === "ss" ? "S&S" : "Unassigned";
  const cartItemWithPrice = (order: NeedsOrderingOrder, line: NeedsOrderingLineItem) => {
    const item = queueById.get(line.id);
    return item ? pricing.read(item).item : { ...buildCartItem(order, line), vendor: null };
  };
  
  // Cleanup Dialog State
  const [dialogTargetStatus, setDialogTargetStatus] = useState<TargetStatus | null>(null);
  const [reviewItems, setReviewItems] = useState<SelectedLineItemInfo[]>([]);
  
  // Handlers for filters
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };
  
  const handleMissingStyleToggle = (checked: boolean) => {
    setMissingStyleOnly(checked);
  };

  const openPoMembership = useMemo(
    () => buildOpenPoMembership(poData?.poFiles ?? []),
    [poData?.poFiles],
  );

  // Derived filtered data
  const filteredOrders = useMemo(() => {
    if (!data?.orders) return [];
    const lowerQuery = searchQuery.toLowerCase().trim();
    
    const matchingOrders = data.orders.map(order => {
      const filteredLines = order.lineItems.filter(li => {
        if (missingStyleOnly && (li.itemNumber && li.itemNumber.trim() !== '')) {
          return false;
        }
        if (!lowerQuery) return true;
        
        const searchStr = [
          order.orderId,
          order.visualId,
          order.customerCompany,
          order.contactName,
          order.nickname,
          li.itemNumber,
          li.brand,
          li.color,
          li.description
        ].filter(Boolean).join(" ").toLowerCase();
        
        return searchStr.includes(lowerQuery);
      });
      return { ...order, lineItems: filteredLines };
    }).filter(order => order.lineItems.length > 0);
    return sortOrdersByUrgency(matchingOrders, urgencyNow);
  }, [data?.orders, searchQuery, missingStyleOnly, urgencyNow]);

  // Derived visible IDs
  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const o of filteredOrders) {
      for (const l of o.lineItems) ids.add(l.id);
    }
    return ids;
  }, [filteredOrders]);

  const allQueueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const order of data?.orders ?? []) {
      for (const line of order.lineItems) ids.add(line.id);
    }
    return ids;
  }, [data?.orders]);

  // Prune only when a row leaves the queue, never merely due to filtering.
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (allQueueIds.has(id)) next.add(id);
      }
      if (next.size !== prev.size) return next;
      return prev;
    });
  }, [allQueueIds]);

  const handleSelectAllShown = () => {
    setSelectedIds(new Set(visibleIds));
  };
  
  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleAddSelectedToCart = () => {
    for (const order of data?.orders ?? []) {
      for (const li of order.lineItems) {
        if (selectedIds.has(li.id)) {
          // The cart's addItem leaves existing entries (and their edits) intact.
          addItem(cartItemWithPrice(order, li));
        }
      }
    }
    setSelectedIds(new Set());
    setCartOpen(true);
  };

  const handleSelectOrder = (orderId: string, lineItems: NeedsOrderingLineItem[], checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) {
        lineItems.forEach(li => next.add(li.id));
      } else {
        lineItems.forEach(li => next.delete(li.id));
      }
      return next;
    });
  };

  const handleSelectRow = (lineItemId: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(lineItemId);
      else next.delete(lineItemId);
      return next;
    });
  };

  // Build full payload for dialog
  const selectedItemsData = useMemo(() => {
    if (selectedIds.size === 0) return [];
    const items: SelectedLineItemInfo[] = [];
    for (const order of data?.orders ?? []) {
      for (const li of order.lineItems) {
        if (selectedIds.has(li.id)) {
          items.push({
            lineItemId: li.id,
            orderId: order.orderId,
            visualId: order.visualId,
            label: li.itemNumber ? `${li.brand || ''} ${li.itemNumber}`.trim() : "Missing style",
            color: li.color || '',
            description: li.description || '',
            inCart: inCart.has(li.id)
          });
        }
      }
    }
    return items;
  }, [selectedIds, data?.orders, inCart]);

  const openCleanup = (status: TargetStatus) => {
    // Freeze the exact reviewed set: queue refreshes must not remove results
    // or change the remaining batches while this confirmation is open.
    setReviewItems(selectedItemsData.map(item => ({ ...item })));
    setDialogTargetStatus(status);
  };

  const handleCleanupSuccess = (updatedIds: string[]) => {
    // Removed successfully cleared rows from local PO cart?
    // Instruction: "Do NOT silently mutate existing cart contents: instead warn if selected items are in cart... to avoid unintended PO edits."
    // So we don't remove them. They are warned in the dialog.
    
    // Unselect the ones that succeeded
    setSelectedIds(prev => {
      const next = new Set(prev);
      updatedIds.forEach(id => next.delete(id));
      return next;
    });
    setDialogTargetStatus(null);
  };

  const selectedPiecesCount = useMemo(() => {
    let count = 0;
    for (const order of data?.orders ?? []) {
      for (const li of order.lineItems) {
        if (selectedIds.has(li.id)) count += (li.items > 0 ? li.items : 0);
      }
    }
    return count;
  }, [data?.orders, selectedIds]);

  const uniqueSelectedInvoicesCount = useMemo(() => {
    const orders = new Set<string>();
    for (const order of data?.orders ?? []) {
      for (const li of order.lineItems) {
        if (selectedIds.has(li.id)) {
          orders.add(order.orderId);
        }
      }
    }
    return orders.size;
  }, [data?.orders, selectedIds]);

  const allVisibleSelected =
    visibleIds.size > 0 && [...visibleIds].every((id) => selectedIds.has(id));

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden relative">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <Truck className="text-[#10b981]" size={24} />
                Vendor Orders
              </h1>
              <p className="text-xs text-slate-400 mt-1">Line items flagged "needs ordering" in Printavo, refreshed by the 5-minute sync</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCartOpen(true)}
                className="relative flex items-center gap-2 text-xs font-bold px-3.5 py-2 rounded-lg bg-[#059669] text-white hover:bg-[#047857] transition-colors"
              >
                <ShoppingCart size={14} />
                PO Cart
                {cartItems.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-white text-[#059669] text-[10px] font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                    {cartItems.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {!isLoading && data && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 mt-3">
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 px-4 py-2 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-400 font-medium flex items-center gap-1.5"><PackageSearch size={13} className="shrink-0" /> Orders Needing Purchase</div>
                <div className="text-2xl font-bold text-white shrink-0" data-testid="text-orders-needing-purchase">{formatNumber(data.totalOrders)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 px-4 py-2 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-400 font-medium flex items-center gap-1.5"><Layers size={13} className="shrink-0" /> Line Items</div>
                <div className="text-2xl font-bold text-white shrink-0" data-testid="text-total-line-items">{formatNumber(data.totalLineItems)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 px-4 py-2 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-400 font-medium flex items-center gap-1.5"><Boxes size={13} className="shrink-0" /> Total Pieces</div>
                <div className="text-2xl font-bold text-[#10b981] shrink-0" data-testid="text-total-pieces">{formatNumber(data.totalPieces)}</div>
              </div>
            </div>
          )}

          {/* Filters Bar */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4 flex-1">
              <div className="relative w-full max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                <input 
                  type="text"
                  placeholder="Search invoice, customer, style, description..."
                  value={searchQuery}
                  onChange={handleSearchChange}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#10b981] focus:ring-1 focus:ring-[#10b981] transition-all"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
                <Checkbox 
                  checked={missingStyleOnly} 
                  onCheckedChange={(c) => handleMissingStyleToggle(!!c)} 
                  className="border-slate-600 data-[state=checked]:bg-[#10b981] data-[state=checked]:border-[#10b981]"
                />
                <span className="flex items-center gap-1"><Filter size={14} className="text-amber-500" /> Missing style number</span>
              </label>
            </div>
            
            <div className="flex items-center gap-3">
              {visibleIds.size > 0 && (
                <button
                  onClick={allVisibleSelected ? handleClearSelection : handleSelectAllShown}
                  className="text-xs font-medium text-slate-400 hover:text-white transition-colors"
                >
                  {allVisibleSelected ? "Clear Selection" : "Select All Shown"}
                </button>
              )}
              <div className="text-xs text-slate-500 bg-slate-800/50 px-2.5 py-1.5 rounded-md border border-slate-800">
                <span className="font-bold text-white">{visibleIds.size}</span> lines visible
              </div>
            </div>
          </div>
          <div
            className="mt-3 flex items-center gap-2 text-xs text-slate-400"
            aria-label="Purchase order highlight legend"
          >
            <span className="h-3 w-3 rounded-sm border border-amber-400/50 bg-amber-400/15" aria-hidden="true" />
            <span><strong className="font-semibold text-amber-300">On open PO</strong> — labels show every matching PO number</span>
            {poDataLoading && <Loader2 className="h-3 w-3 animate-spin" aria-label="Loading purchase order membership" />}
            {poDataError && <span className="text-red-400" role="status">PO highlights unavailable</span>}
          </div>
        </div>

        {error && (
          <div className="p-4 m-6 mb-0 bg-red-900/20 border border-red-900/50 rounded-lg flex items-start gap-3 text-red-400">
            <AlertTriangle size={20} className="mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-bold text-sm">Failed to load vendor orders</div>
              <div className="text-xs opacity-80 mt-1">{error instanceof Error ? error.message : "Network error"}</div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="animate-spin text-[#10b981]" size={32} />
            </div>
          ) : !data || data.orders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-500">
              <PackageSearch size={40} className="mb-3 opacity-50" />
              <div className="text-sm font-medium">Nothing needs ordering right now</div>
              <div className="text-xs mt-1">Line items marked "needs ordering" in Printavo will appear here within ~5 minutes.</div>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-500">
              <Filter size={40} className="mb-3 opacity-50" />
              <div className="text-sm font-medium">No results match your filters</div>
              <button 
                onClick={() => { setSearchQuery(""); setMissingStyleOnly(false); }}
                className="mt-3 text-xs text-[#10b981] hover:underline"
              >
                Clear all filters
              </button>
            </div>
          ) : (
            filteredOrders.map((order) => {
              // Check if all lines in THIS order (that are currently visible) are selected
              const allSelected = order.lineItems.length > 0 && order.lineItems.every(li => selectedIds.has(li.id));
              const someSelected = order.lineItems.some(li => selectedIds.has(li.id));
              const urgency = getOrderUrgency(order, urgencyNow);

              return (
                <div key={order.orderId} className={`border transition-colors rounded-xl overflow-hidden ${
                  someSelected
                    ? "bg-slate-900/40 border-[#10b981]/50"
                    : urgency.urgent
                      ? "bg-rose-950/20 border-rose-500/60"
                      : "bg-slate-900/40 border-slate-800"
                }`}>
                  <div className={`px-5 py-2.5 border-b flex flex-wrap items-center justify-between gap-x-3 gap-y-2 ${
                    urgency.urgent
                      ? "border-rose-500/30 bg-rose-950/30"
                      : "border-slate-800 bg-slate-900/60"
                  }`}>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="flex items-center h-full">
                         <Checkbox 
                           checked={allSelected ? true : someSelected ? "indeterminate" : false}
                           onCheckedChange={(c) => handleSelectOrder(order.orderId, order.lineItems, c !== false)}
                           className="border-slate-500 data-[state=checked]:bg-[#10b981] data-[state=checked]:border-[#10b981]"
                           title="Select all shown lines in this invoice"
                         />
                      </div>
                      <div>
                        <div className="text-base font-bold text-white">
                          <PrintavoOrderLink orderId={order.orderId} visualId={order.visualId} />
                        </div>
                         <div className="text-xs text-slate-400">{order.nickname || "—"}</div>
                          {urgency.reasons.some((reason) => reason.kind === "nickname") && (
                            <div className="mt-1 flex flex-wrap gap-1.5" aria-label="Urgency reasons">
                              {urgency.reasons.filter((reason) => reason.kind === "nickname").map((reason) => (
                               <span
                                 key={`${reason.kind}-${reason.label}`}
                                 className="inline-flex items-center gap-1 rounded border border-rose-400/50 bg-rose-950/70 px-2 py-0.5 text-[10px] font-bold text-rose-200"
                               >
                                 <AlertTriangle size={10} aria-hidden="true" />
                                 {reason.label}
                               </span>
                             ))}
                           </div>
                         )}
                      </div>
                      <div className="h-8 w-px bg-slate-800" />
                      <div>
                        <div className="text-sm font-medium text-slate-200">{order.customerCompany || order.contactName || "—"}</div>
                        <div className="text-xs text-slate-500">{order.contactName && order.customerCompany ? order.contactName : ""}</div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex flex-col items-start gap-1">
                        {urgency.reasons.some((reason) => reason.kind !== "nickname") && (
                          <div className="flex flex-wrap gap-1.5" aria-label="Production urgency reasons" data-testid={`status-production-urgency-${order.orderId}`}>
                            {urgency.reasons.filter((reason) => reason.kind !== "nickname").map((reason) => (
                              <span
                                key={`${reason.kind}-${reason.label}`}
                                className="inline-flex items-center gap-1 rounded border border-rose-400/50 bg-rose-950/70 px-2 py-0.5 text-[10px] font-bold text-rose-200"
                              >
                                <AlertTriangle size={10} aria-hidden="true" />
                                {reason.label}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="text-xs text-slate-400 flex items-center gap-1.5">
                          <CalendarClock size={13} className="shrink-0" />
                          <span>Prod due {formatPrintavoCalendarDate(order.productionDueAt)}</span>
                        </div>
                      </div>
                      <span className="inline-flex items-center px-2 py-1 rounded text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                        {statusPill(order.statusName)}
                      </span>
                    </div>
                  </div>
                  <table className="w-full text-sm text-left">
                    <thead className="text-[11px] text-slate-400 bg-slate-900/80 uppercase tracking-wider">
                      <tr>
                        <th className="px-5 py-2.5 w-10"></th>
                        <th className="px-5 py-2.5 font-semibold">Style</th>
                        <th className="px-5 py-2.5 font-semibold">Color</th>
                        <th className="px-5 py-2.5 font-semibold">Description</th>
                        <th className="px-5 py-2.5 font-semibold">Sizes</th>
                        <th className="px-5 py-2.5 font-semibold text-right">Qty</th>
                        <th className="px-5 py-2.5 font-semibold">Source / Purchase estimate</th>
                        <th className="px-5 py-2.5 font-semibold text-right">Cart</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {order.lineItems.map((li) => {
                        const warn = staleWarning(order, li);
                        const added = inCart.has(li.id);
                        const isSelected = selectedIds.has(li.id);
                        const isBlankStyle = !li.itemNumber || li.itemNumber.trim() === '';
                        const poNumbers = openPoMembership.get(stableLineIdentity(order.orderId, li.id)) ?? [];
                        const isOnOpenPo = poNumbers.length > 0;
                        
                        return (
                          <tr
                            key={li.id}
                            className={`transition-colors border-l-2 ${
                              isSelected
                                ? "bg-[#10b981]/10 border-l-[#10b981]"
                                : isOnOpenPo
                                  ? "bg-amber-400/[0.07] border-l-amber-400 hover:bg-amber-400/[0.1]"
                                  : "border-l-transparent hover:bg-slate-800/30"
                            }`}
                          >
                            <td className="px-5 py-3">
                               <Checkbox 
                                 checked={isSelected}
                                 onCheckedChange={(c) => handleSelectRow(li.id, !!c)}
                                 className="border-slate-600 data-[state=checked]:bg-[#10b981] data-[state=checked]:border-[#10b981]"
                               />
                            </td>
                            <td className="px-5 py-3">
                              <div className={`font-mono font-semibold ${isBlankStyle ? 'text-amber-500 text-xs italic' : 'text-slate-200'}`}>
                                {isBlankStyle ? "Missing style" : li.itemNumber}
                              </div>
                              <div className="text-[11px] text-slate-500">{li.brand || ""}</div>
                               {isOnOpenPo && (
                                 <div className="mt-1 flex flex-wrap gap-1" aria-label={`On open purchase order${poNumbers.length === 1 ? "" : "s"} ${poNumbers.join(", ")}`}>
                                   {poNumbers.map((poNumber) => (
                                     <span
                                       key={poNumber}
                                       className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-300"
                                       aria-label={`Purchase order ${poNumber}`}
                                     >
                                       PO {poNumber}
                                     </span>
                                   ))}
                                 </div>
                               )}
                            </td>
                            <td className="px-5 py-3 text-slate-300">{li.color || "—"}</td>
                            <td className="px-5 py-3 text-slate-400 max-w-[280px]">
                              <div className="truncate">{li.description || "—"}</div>
                              {warn && (
                                <div className="flex items-center gap-1 text-[11px] text-amber-400 mt-0.5">
                                  <AlertTriangle size={11} className="flex-shrink-0" />
                                  {warn}
                                </div>
                              )}
                            </td>
                            <td className="px-5 py-3">
                              <div className="flex flex-wrap gap-1">
                                {li.sizes.length === 0 ? (
                                  <span className="text-slate-600 text-xs">—</span>
                                ) : (
                                  li.sizes.map((s, i) => (
                                    <span key={i} className="text-[10px] font-mono bg-slate-800 border border-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                                      {s.size}×{s.count}
                                    </span>
                                  ))
                                )}
                              </div>
                            </td>
                            <td className="px-5 py-3 text-right font-mono font-bold text-[#10b981]">{formatNumber(li.items)}</td>
                            <td className="px-5 py-3 min-w-64">
                              {(() => {
                                const item = queueById.get(li.id)!;
                                const quote = pricing.read(item);
                                const totals = purchaseTotal(quote.item);
                                const suggestion = guessVendor(li.brand);
                                return <div className="space-y-1 text-xs" data-testid={`purchase-price-${li.id}`}>
                                  <select
                                    data-testid={`select-source-vendor-${li.id}`}
                                    aria-label={`Source vendor for ${li.itemNumber ?? li.id}`}
                                    className="bg-slate-900 border border-slate-700 rounded p-1 text-slate-200"
                                    value={item.vendor ?? ""}
                                    onChange={e => setSourceVendors(v => ({ ...v, [li.id]: (e.target.value || null) as CartVendor | null }))}
                                  >
                                    <option value="">Choose vendor</option>
                                    <option value="sanmar">SanMar</option>
                                    <option value="ss">S&amp;S Activewear</option>
                                  </select>
                                  {!item.vendor && suggestion && <div className="text-amber-300">Suggestion only: {sourceLabel(suggestion)}</div>}
                                  {item.vendor && !Object.prototype.hasOwnProperty.call(sourceVendors, li.id) &&
                                    <div className="text-slate-400">{savedSourceVendor(item, poData?.poFiles ?? []) ? "Source: saved PO for this invoice line" : "Suggested vendor — change if needed"}</div>}
                                  {quote.item.vendorCatalogColor && quote.item.vendorCatalogColor !== item.color &&
                                    <div className="text-amber-300">Matched vendor color: {quote.item.vendorCatalogColor} — verify before saving</div>}
                                  {quote.item.sizes.filter(s => s.qty > 0).map((s, index) =>
                                    <div key={index} className="font-mono text-slate-300">
                                      {s.size} × {s.qty}: {s.unitCost === null ? "Price unavailable" :
                                        `${purchaseMoney(s.unitCost)} ea · ${purchaseMoney(s.unitCost * s.qty)}`}
                                    </div>)}
                                  <div className={totals.incomplete ? "text-amber-300" : "text-emerald-400"}>
                                    {!totals.pricedSizes ? "Price unavailable — incomplete" : totals.incomplete ? `Known subtotal ${purchaseMoney(totals.total)} · Incomplete (unpriced sizes excluded)` : `Extended ${purchaseMoney(totals.total)}`}
                                  </div>
                                  <div className="text-slate-500">{quote.message}</div>
                                  <QueueMatchReview key={pricingContext(item)} item={item}
                                    result={pricing.result(item)} onStyle={pricing.chooseStyle} onApprove={pricing.approve} />
                                  <details>
                                    <summary className="cursor-pointer text-slate-400" data-testid={`edit-purchase-${li.id}`}>Edit purchase inputs</summary>
                                    <div className="space-y-1 pt-1">
                                      <div className="text-amber-300">Local purchase inputs only; Printavo is unchanged.</div>
                                      <input aria-label="Purchase style" data-testid={`purchase-style-${li.id}`}
                                        className="w-full bg-slate-900 border border-slate-700 rounded p-1"
                                        value={item.styleNumber}
                                        onChange={e => editPurchaseItem(order, li, item, { styleNumber: e.target.value })} />
                                      <input aria-label="Purchase color" data-testid={`purchase-color-${li.id}`}
                                        className="w-full bg-slate-900 border border-slate-700 rounded p-1"
                                        value={item.color ?? ""}
                                        onChange={e => editPurchaseItem(order, li, item, { color: e.target.value })} />
                                      {item.sizes.map((size, index) => <div key={index} className="flex gap-1">
                                        <input aria-label={`Purchase size ${index + 1}`} data-testid={`purchase-size-${li.id}-${index}`}
                                          className="w-20 bg-slate-900 border border-slate-700 rounded p-1"
                                          value={size.size}
                                          onChange={e => editPurchaseItem(order, li, item, { sizes: item.sizes.map((s, n) => n === index ? { ...s, size: e.target.value } : s) })} />
                                        <input aria-label={`Purchase quantity ${index + 1}`} data-testid={`purchase-qty-${li.id}-${index}`}
                                          type="number" min="0" step="1"
                                          className="w-20 bg-slate-900 border border-slate-700 rounded p-1"
                                          value={size.qty}
                                          onChange={e => {
                                            const qty = Number(e.target.value);
                                            if (Number.isSafeInteger(qty) && qty >= 0) editPurchaseItem(order, li, item, {
                                              sizes: item.sizes.map((s, n) => n === index ? { ...s, qty } : s),
                                            });
                                          }} />
                                      </div>)}
                                    </div>
                                  </details>
                                </div>;
                              })()}
                            </td>
                            <td className="px-5 py-3 text-right">
                              <button
                                onClick={() => {
                                  if (added) {
                                    removeItem(li.id);
                                  } else {
                                    addItem(cartItemWithPrice(order, li));
                                    setCartOpen(true);
                                  }
                                }}
                                className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-md border transition-colors ${
                                  added
                                    ? "bg-[#059669]/10 text-[#10b981] border-[#059669]/30 hover:bg-[#059669]/20"
                                    : "bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700"
                                }`}
                              >
                                {added ? <Check size={12} /> : <Plus size={12} />}
                                {added ? "Added" : "Add"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })
          )}
        </div>

        {/* Keep all selection actions visible without covering the last rows. */}
        {selectedIds.size > 0 && (
          <div className="flex-shrink-0 bg-[#0f172a] border-t border-[#10b981]/50 shadow-[0_-10px_40px_-10px_rgba(16,185,129,0.2)] p-4 px-6 flex flex-wrap gap-3 items-center justify-between z-10 animate-in slide-in-from-bottom-4">
            <div className="flex items-center gap-4">
              <div className="bg-[#10b981]/20 text-[#10b981] px-3 py-1.5 rounded-lg border border-[#10b981]/30 flex items-center gap-2">
                <span className="font-black text-lg">{selectedIds.size}</span>
                <div className="text-xs font-medium uppercase tracking-wider leading-tight">
                  Lines<br/>Selected
                </div>
              </div>
              <div className="text-xs text-slate-400 flex flex-col justify-center">
                <span><strong className="text-slate-200">{uniqueSelectedInvoicesCount}</strong> Invoices</span>
                <span><strong className="text-slate-200">{selectedPiecesCount}</strong> Pieces</span>
              </div>
            </div>
            
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-xs text-slate-300" data-testid="selected-vendor-spend">
                {[...selectedSpend].map(([vendor, totals]) => <div key={vendor}>
                  {sourceLabel(vendor)} selected spend: {totals.pricedSizes ? purchaseMoney(totals.total) : "— no resolved prices"}
                  {totals.incomplete && <span className="text-amber-300"> · Incomplete — unpriced sizes excluded</span>}
                </div>)}
                <div className="text-slate-500">Shipping terms not configured. Estimates exclude shipping/tax; SanMar broken-case charges may be higher. Recent vendor responses may be reused for up to 15 minutes.</div>
              </div>
              <label className="text-xs text-slate-300">Apply vendor to selected lines / invoices
                <select data-testid="bulk-source-vendor" aria-label="Apply vendor to selected lines and invoices"
                  value="" className="ml-2 bg-slate-900 border border-slate-700 rounded p-2"
                  onChange={e => {
                    const vendor = e.target.value as CartVendor;
                    if (vendor) setSourceVendors(previous => applySelectedQueueVendor(queueItems, selectedIds, previous, vendor));
                  }}>
                  <option value="">Choose vendor…</option>
                  <option value="sanmar">SanMar</option>
                  <option value="ss">S&amp;S Activewear</option>
                </select>
              </label>
              <button data-testid="get-selected-prices"
                onClick={async () => {
                  await Promise.all(queueItems.filter(item => selectedIds.has(item.key)).map(item => pricing.price(item)));
                }}
                className="px-3 py-2 text-sm border border-slate-700 rounded-lg text-slate-200">
                Get Prices
              </button>
              <button data-testid="refresh-selected-prices"
                title="Recheck selected lines. The vendor service may reuse its recent cached response."
                onClick={async () => {
                  await Promise.all(queueItems.filter(item => selectedIds.has(item.key)).map(item => pricing.price(item, true)));
                }}
                className="px-3 py-2 text-sm border border-slate-700 rounded-lg text-slate-200">
                Refresh Prices
              </button>
              <button
                onClick={handleAddSelectedToCart}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#059669] hover:bg-[#047857] text-white text-sm font-bold rounded-lg transition-colors"
                title="Add selected lines without changing their Printavo product status. Items already in the cart stay unchanged."
              >
                <ShoppingCart size={16} />
                Add Selected to PO Cart
              </button>

              <div className="w-px h-8 bg-slate-700 mx-2" />

              <span className="text-xs font-medium text-slate-500 uppercase tracking-wider mr-2">Set Status To:</span>
              
              <button 
                onClick={() => openCleanup("unset")}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-bold rounded-lg border border-slate-700 transition-colors"
              >
                Unset
              </button>
              
              <button 
                onClick={() => openCleanup("ordered")}
                className="px-4 py-2 bg-[#0ea5e9]/20 hover:bg-[#0ea5e9]/30 text-[#38bdf8] text-sm font-bold rounded-lg border border-[#0ea5e9]/30 transition-colors"
              >
                Ordered
              </button>
              
              <button 
                onClick={() => openCleanup("received")}
                className="px-4 py-2 bg-[#10b981]/20 hover:bg-[#10b981]/30 text-[#34d399] text-sm font-bold rounded-lg border border-[#10b981]/30 transition-colors"
              >
                Received
              </button>
              
              <div className="w-px h-8 bg-slate-700 mx-2" />
              
              <button 
                onClick={handleClearSelection}
                className="text-xs text-slate-400 hover:text-white transition-colors"
              >
                Clear All
              </button>
            </div>
          </div>
        )}
      </div>
      
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
      
      <BulkCleanupDialog 
        isOpen={!!dialogTargetStatus}
        onClose={() => setDialogTargetStatus(null)}
        items={reviewItems}
        targetStatus={dialogTargetStatus}
        onSuccess={handleCleanupSuccess}
      />
    </AppShell>
  );
}
