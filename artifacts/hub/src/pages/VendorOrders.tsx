import { useState, useMemo, useEffect } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { useGetNeedsOrdering, type NeedsOrderingOrder, type NeedsOrderingLineItem } from "@workspace/api-client-react";
import { formatNumber, formatDate } from "@/lib/format";
import { usePoCart, guessVendor, type CartItem } from "@/stores/poCart";
import { CartDrawer } from "@/components/purchasing/CartDrawer";
import { Truck, Loader2, PackageSearch, Layers, Boxes, CalendarClock, ShoppingCart, Plus, Check, AlertTriangle, Search, Filter } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkCleanupDialog, type SelectedLineItemInfo, type TargetStatus } from "@/components/purchasing/BulkCleanupDialog";

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

function buildCartItem(order: NeedsOrderingOrder, li: NeedsOrderingLineItem): CartItem {
  const sizes =
    li.sizes.length > 0
      ? li.sizes.map((s) => ({
          size: s.size,
          qty: s.count,
          unitCost: null,
          sku: null,
          inventoryKey: null,
          sizeIndex: null,
          vendorSize: null,
        }))
      : [{ size: "OSFA", qty: li.items > 0 ? li.items : 0, unitCost: null, sku: null, inventoryKey: null, sizeIndex: null, vendorSize: null }];
  return {
    key: li.id,
    printavoLineItemId: li.id,
    printavoOrderId: order.orderId,
    visualId: order.visualId,
    styleNumber: li.itemNumber ?? "",
    color: li.color,
    description: li.description,
    brand: li.brand,
    vendor: guessVendor(li.brand),
    vendorCatalogColor: null,
    vendorStyleId: null,
    resolved: false,
    sizes,
    inventory: null,
    warehouseCode: null,
    warehouseName: null,
    warehouseManual: false,
  };
}

export default function VendorOrders() {
  const { data, isLoading, error } = useGetNeedsOrdering();
  const cartItems = usePoCart((s) => s.items);
  const addItem = usePoCart((s) => s.addItem);
  const removeItem = usePoCart((s) => s.removeItem);
  const [cartOpen, setCartOpen] = useState(false);
  const inCart = useMemo(() => new Set(cartItems.map((i) => i.key)), [cartItems]);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [missingStyleOnly, setMissingStyleOnly] = useState(false);

  // Bulk Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  // Cleanup Dialog State
  const [dialogTargetStatus, setDialogTargetStatus] = useState<TargetStatus | null>(null);
  const [reviewItems, setReviewItems] = useState<SelectedLineItemInfo[]>([]);
  
  // Handlers for filters
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setSelectedIds(new Set()); // clear selection on filter changes
  };
  
  const handleMissingStyleToggle = (checked: boolean) => {
    setMissingStyleOnly(checked);
    setSelectedIds(new Set()); // clear selection on filter changes
  };

  // Derived filtered data
  const filteredOrders = useMemo(() => {
    if (!data?.orders) return [];
    const lowerQuery = searchQuery.toLowerCase().trim();
    
    return data.orders.map(order => {
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
  }, [data?.orders, searchQuery, missingStyleOnly]);

  // Derived visible IDs
  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const o of filteredOrders) {
      for (const l of o.lineItems) ids.add(l.id);
    }
    return ids;
  }, [filteredOrders]);

  // Prune selection if items disappear (e.g. background refetch or filter change)
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
      }
      if (next.size !== prev.size) return next;
      return prev;
    });
  }, [visibleIds]);

  const handleSelectAllShown = () => {
    setSelectedIds(new Set(visibleIds));
  };
  
  const handleClearSelection = () => {
    setSelectedIds(new Set());
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
    for (const order of filteredOrders) {
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
  }, [selectedIds, filteredOrders, inCart]);

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
    for (const order of filteredOrders) {
      for (const li of order.lineItems) {
        if (selectedIds.has(li.id)) count += (li.items > 0 ? li.items : 0);
      }
    }
    return count;
  }, [filteredOrders, selectedIds]);

  const uniqueSelectedInvoicesCount = useMemo(() => {
    const orders = new Set<string>();
    for (const order of filteredOrders) {
      for (const li of order.lineItems) {
        if (selectedIds.has(li.id)) {
          orders.add(order.orderId);
        }
      }
    }
    return orders.size;
  }, [filteredOrders, selectedIds]);

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
            <div className="grid grid-cols-3 gap-4 mt-5">
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><PackageSearch size={13} /> Orders Needing Purchase</div>
                <div className="text-2xl font-bold text-white">{formatNumber(data.totalOrders)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><Layers size={13} /> Line Items</div>
                <div className="text-2xl font-bold text-white">{formatNumber(data.totalLineItems)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><Boxes size={13} /> Total Pieces</div>
                <div className="text-2xl font-bold text-[#10b981]">{formatNumber(data.totalPieces)}</div>
              </div>
            </div>
          )}

          {/* Filters Bar */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
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
                  onClick={visibleIds.size === selectedIds.size && visibleIds.size > 0 ? handleClearSelection : handleSelectAllShown}
                  className="text-xs font-medium text-slate-400 hover:text-white transition-colors"
                >
                  {visibleIds.size === selectedIds.size && visibleIds.size > 0 ? "Clear Selection" : "Select All Shown"}
                </button>
              )}
              <div className="text-xs text-slate-500 bg-slate-800/50 px-2.5 py-1.5 rounded-md border border-slate-800">
                <span className="font-bold text-white">{visibleIds.size}</span> lines visible
              </div>
            </div>
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

        <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar pb-24">
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

              return (
                <div key={order.orderId} className={`bg-slate-900/40 border transition-colors rounded-xl overflow-hidden ${someSelected ? 'border-[#10b981]/50' : 'border-slate-800'}`}>
                  <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-900/60">
                    <div className="flex items-center gap-4">
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
                        <div className="text-xs text-slate-500">{order.nickname || "—"}</div>
                      </div>
                      <div className="h-8 w-px bg-slate-800" />
                      <div>
                        <div className="text-sm font-medium text-slate-200">{order.customerCompany || order.contactName || "—"}</div>
                        <div className="text-xs text-slate-500">{order.contactName && order.customerCompany ? order.contactName : ""}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-xs text-slate-400 flex items-center gap-1.5">
                        <CalendarClock size={13} />
                        <span>Prod due {formatDate(order.productionDueAt)}</span>
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
                        <th className="px-5 py-2.5 font-semibold text-right">Cart</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {order.lineItems.map((li) => {
                        const warn = staleWarning(order, li);
                        const added = inCart.has(li.id);
                        const isSelected = selectedIds.has(li.id);
                        const isBlankStyle = !li.itemNumber || li.itemNumber.trim() === '';
                        
                        return (
                          <tr key={li.id} className={`transition-colors ${isSelected ? 'bg-[#10b981]/10' : 'hover:bg-slate-800/30'}`}>
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
                            <td className="px-5 py-3 text-right">
                              <button
                                onClick={() => {
                                  if (added) {
                                    removeItem(li.id);
                                  } else {
                                    addItem(buildCartItem(order, li));
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

        {/* Selection Action Bar (Fixed at bottom) */}
        {selectedIds.size > 0 && (
          <div className="absolute bottom-0 left-0 right-0 bg-[#0f172a] border-t border-[#10b981]/50 shadow-[0_-10px_40px_-10px_rgba(16,185,129,0.2)] p-4 px-6 flex flex-wrap gap-3 items-center justify-between z-10 animate-in slide-in-from-bottom-4">
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
