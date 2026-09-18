import { useState, useRef, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Search, X, AlertTriangle, CheckCircle, RefreshCw, Star } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { CollectionPicker } from "@/components/collections/CollectionPicker";
import {
  useProductSearch,
  productSearch,
  vendorInventory,
  useGetFinderOrder,
  getGetFinderOrderQueryKey,
  useCatalogSearch,
  getCatalogSearchQueryKey,
  useGetCatalogFilters,
  getGetCatalogFiltersQueryKey,
  useGetCatalogHealth,
  getGetCatalogHealthQueryKey,
  useTriggerCatalogRefresh,
  useSetCatalogTagOverride,
  useSetCatalogColorFamily,
  type VendorLookupResult,
  type VendorColorOffer,
  type VendorSizeOffer,
  type VendorInventoryResult,
  type FinderOrderLineItem,
  type CatalogSearchHit,
  type CatalogMatchedColor,
  type CatalogHealth,
} from "@workspace/api-client-react";
import { CapAmericaSampleCatalog } from "@/components/purchasing/CapAmericaSampleCatalog";

// --- Types ---
interface SessionSelection {
  id: string;
  vendor: "sanmar" | "ss";
  styleName: string;
  styleId: string | null;
  colorName: string;
  productImage: string | null;
  sizes: VendorSizeOffer[];
  inventory: VendorInventoryResult | null;
  isLoadingInventory: boolean;
  error: string | null;
}

interface InvoiceLineState {
  line: FinderOrderLineItem;
  status: "idle" | "searching" | "checking_inventory" | "done" | "error";
  error?: string;
  lookupResult?: VendorLookupResult;
  colorOffer?: VendorColorOffer;
  inventoryResult?: VendorInventoryResult;
}

// --- Shared Components ---

function InventoryGrid({ sizes, inventory, neededSizes }: { sizes: VendorSizeOffer[], inventory?: VendorInventoryResult | null, neededSizes?: FinderOrderLineItem["sizes"] }) {
  const warehousesSource = inventory
    ? inventory.sizes
    : sizes.map(s => ({ size: s.size, warehouses: s.warehouses || [] }));

  const allWarehousesMap = new Map<string, string>();
  warehousesSource.forEach(s => {
    s.warehouses?.forEach(w => allWarehousesMap.set(w.code, (w as any).name || w.code));
  });
  const allWarehouses = Array.from(allWarehousesMap.entries());

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full text-[11px] text-left text-slate-300">
        <thead className="text-slate-400 border-b border-slate-800 uppercase tracking-wider">
          <tr>
            <th className="py-2 px-3 font-semibold w-32">Warehouse</th>
            {sizes.map(s => {
               const needed = neededSizes?.find(n => n.size === s.size);
               return (
                 <th key={s.size} className="py-2 px-2 text-center min-w-[40px]">
                   <div className="font-semibold text-slate-200">{s.size}</div>
                   {needed && <div className="text-[10px] text-amber-400 mt-0.5 bg-amber-400/10 rounded px-1 inline-block">Need {needed.count}</div>}
                 </th>
               )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {allWarehouses.map(([code, name]) => (
            <tr key={code} className="hover:bg-slate-800/20 transition-colors">
              <td className="py-2 px-3 font-medium text-slate-400 truncate max-w-[120px]" title={name}>{name}</td>
              {sizes.map(s => {
                 const invSize = warehousesSource.find(is => is.size === s.size);
                 const wh = invSize?.warehouses?.find(w => w.code === code);
                 const qty = wh ? wh.qty : 0;
                 return (
                   <td key={s.size} className={`py-2 px-2 text-center font-mono ${qty > 0 ? "text-slate-200 font-semibold" : "text-slate-600"}`}>
                     {wh ? ((wh as any).capped ? `${wh.qty}+` : wh.qty) : "-"}
                   </td>
                 )
              })}
            </tr>
          ))}
          {/* Cost Row */}
          <tr className="bg-slate-900/50">
             <td className="py-2 px-3 text-slate-400 font-medium">Cost</td>
             {sizes.map(s => (
                <td key={s.size} className="py-2 px-2 text-center text-[#10b981] font-mono font-bold">
                  {s.cost != null ? `$${s.cost.toFixed(2)}` : "-"}
                  {s.salePrice != null && <span className="text-[10px] text-red-400 line-through block font-normal">${s.salePrice.toFixed(2)}</span>}
                </td>
             ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function VendorResultCard({ vendorResult, onColorSelect }: { vendorResult: any, onColorSelect: (c: VendorColorOffer) => void }) {
  const { lookup, aliasUsed } = vendorResult;
  if (!lookup.found) {
    return (
      <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
        <div className="font-bold text-slate-400 capitalize flex items-center gap-2">
           {lookup.vendor}
        </div>
        <div className="text-xs font-medium text-slate-500 bg-slate-800/50 px-2 py-1 rounded">Not carried</div>
      </div>
    );
  }

  return (
    <div className="bg-slate-900/60 border border-slate-700/50 rounded-xl p-5 space-y-4 shadow-sm relative overflow-hidden group hover:border-slate-600 transition-colors">
      <div className="flex justify-between items-start gap-4">
         <div className="flex-1 min-w-0">
           <div className="flex items-center gap-2 mb-1">
             <div className="font-bold text-white capitalize text-lg">{lookup.vendor}</div>
             {lookup.matchType === "closest" && <Badge variant="secondary" className="text-[10px] h-5 bg-amber-500/20 text-amber-400 border-0 hover:bg-amber-500/20">Closest match</Badge>}
             {aliasUsed && <Badge variant="secondary" className="text-[10px] h-5 border-0 bg-slate-800">Alias: {aliasUsed}</Badge>}
           </div>
           <div className="text-sm font-semibold text-[#10b981] flex items-center gap-1.5 truncate">
             <span className="text-slate-300 font-mono text-xs">{lookup.styleName}</span>
             <span className="text-slate-600">&bull;</span>
             {lookup.title}
           </div>
           <div className="text-xs text-slate-500 mt-1">{lookup.brand}</div>
           <div className="mt-2">
             <CollectionPicker items={[{ vendor: lookup.vendor as any, styleName: lookup.styleName || "" }]}>
               <Button variant="outline" size="sm" className="bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white h-7 text-[10px] px-2">
                 <Star className="w-3 h-3 mr-1" /> Save
               </Button>
             </CollectionPicker>
           </div>
         </div>
         {lookup.styleImage && (
           <div className="w-16 h-16 rounded-md bg-white/5 border border-white/10 overflow-hidden flex-shrink-0 flex items-center justify-center p-1">
             <img src={lookup.styleImage} className="max-w-full max-h-full object-contain mix-blend-screen" alt={lookup.title} />
           </div>
         )}
      </div>
      
      <div className="pt-3 border-t border-slate-800/50">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Available Colors</div>
        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto custom-scrollbar pr-1">
           {lookup.colors.map((color: VendorColorOffer) => (
              <button
                 key={color.colorName}
                 onClick={() => onColorSelect(color)}
                 className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded bg-slate-800/80 hover:bg-slate-700 border border-slate-700 hover:border-slate-500 transition-colors group/btn"
              >
                 {color.swatchImage ? (
                    <img src={color.swatchImage} className="w-4 h-4 rounded-sm shadow-sm" alt="" />
                 ) : (
                    <div className="w-4 h-4 rounded-sm bg-slate-600 shadow-sm" />
                 )}
                 <span className="text-[11px] font-medium text-slate-300 group-hover/btn:text-white transition-colors">{color.colorName}</span>
              </button>
           ))}
        </div>
      </div>
    </div>
  )
}

function SelectionCard({ selection, onRemove }: { selection: SessionSelection, onRemove: () => void }) {
  const { sizes } = selection;

  return (
    <div className="bg-[#0f172a] border border-slate-700 rounded-xl overflow-hidden shadow-lg relative group">
      <div className="absolute top-0 left-0 w-1 h-full bg-[#10b981]" />
      <button onClick={onRemove} className="absolute top-3 right-3 p-1.5 text-slate-500 hover:text-white hover:bg-slate-800 rounded-md transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100">
        <X size={14}/>
      </button>
      
      <div className="p-5 flex flex-col sm:flex-row gap-5">
        {selection.productImage ? (
           <div className="w-full sm:w-28 h-28 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center p-2 flex-shrink-0">
              <img src={selection.productImage} className="max-w-full max-h-full object-contain mix-blend-screen" alt="" />
           </div>
        ) : (
           <div className="w-full sm:w-28 h-28 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0 border border-slate-700">
              <span className="text-xs text-slate-500">No Image</span>
           </div>
        )}
        
        <div className="flex-1 min-w-0">
           <div className="flex items-center gap-2 mb-1 pr-6">
             <div className="font-bold text-white text-lg truncate" title={`${selection.styleName} in ${selection.colorName}`}>
                {selection.styleName}
             </div>
             <div className="text-sm font-medium text-[#10b981] px-2 py-0.5 rounded-full bg-[#059669]/10 border border-[#059669]/20 truncate">
                {selection.colorName}
             </div>
           </div>
           <div className="text-xs font-bold text-slate-400 capitalize tracking-wider">{selection.vendor}</div>

           <div className="mt-5 bg-slate-900/50 rounded-lg border border-slate-800 p-1 relative">
              {selection.isLoadingInventory && (
                 <div className="absolute inset-0 bg-slate-900/50 flex items-center justify-center backdrop-blur-sm z-10 rounded-lg">
                    <div className="flex items-center gap-2 text-sm font-medium text-white bg-slate-800/90 px-4 py-2 rounded-full border border-slate-700 shadow-xl">
                      <Loader2 className="animate-spin w-4 h-4 text-[#10b981]" />
                      Fetching live stock...
                    </div>
                 </div>
              )}
              <InventoryGrid sizes={sizes} inventory={selection.inventory} />
           </div>
           
           {selection.error && (
              <div className="mt-3 text-sm text-red-400 bg-red-950/20 p-4 rounded-lg border border-red-900/50 flex items-center gap-2">
                 <AlertTriangle size={16} />
                 Failed to load live inventory: {selection.error}
              </div>
           )}
        </div>
      </div>
    </div>
  )
}

// --- Modes ---

function StyleSearchMode({ initialQuery, onClearInitialQuery }: { initialQuery?: string, onClearInitialQuery?: () => void }) {
  const [query, setQuery] = useState("");
  const searchMutation = useProductSearch();
  const [selections, setSelections] = useState<SessionSelection[]>([]);

  const onClearRef = useRef(onClearInitialQuery);
  onClearRef.current = onClearInitialQuery;
  const mutateRef = useRef(searchMutation.mutate);
  mutateRef.current = searchMutation.mutate;

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      mutateRef.current({ data: { query: initialQuery } });
      onClearRef.current?.();
    }
  }, [initialQuery]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    searchMutation.mutate({ data: { query: query.trim() } });
  };

  const addSelection = async (lookup: VendorLookupResult, color: VendorColorOffer) => {
    const newSelection: SessionSelection = {
      id: `${lookup.vendor}-${lookup.styleName}-${color.colorName}-${Date.now()}`,
      vendor: lookup.vendor,
      styleName: lookup.styleName || "",
      styleId: lookup.styleId,
      colorName: color.colorName,
      productImage: color.productImage || lookup.styleImage,
      sizes: color.sizes,
      inventory: null,
      isLoadingInventory: true,
      error: null,
    };
    setSelections(prev => [newSelection, ...prev]);

    try {
      const invResult = await vendorInventory({
        vendor: lookup.vendor,
        style: lookup.styleName || "",
        styleId: lookup.styleId,
        catalogColor: color.colorName,
        sizes: color.sizes.map(s => s.size),
      });
      setSelections(prev => prev.map(s => s.id === newSelection.id ? { ...s, inventory: invResult, isLoadingInventory: false } : s));
    } catch (err: any) {
      setSelections(prev => prev.map(s => s.id === newSelection.id ? { ...s, error: err.message || String(err), isLoadingInventory: false } : s));
    }
  }

  const removeSelection = (id: string) => {
    setSelections(prev => prev.filter(s => s.id !== id));
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 lg:h-full pb-0">
      {/* Left Column: Search & Results */}
      <div className="w-full lg:w-[400px] flex flex-col gap-5 lg:border-r border-slate-800 lg:pr-6 flex-shrink-0">
        <form onSubmit={handleSearch} className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4" />
          <Input 
            placeholder="Search style (e.g. PC54)..." 
            value={query} 
            onChange={e => setQuery(e.target.value)} 
            autoFocus 
            className="pl-9 bg-slate-900 border-slate-700 h-10 text-sm shadow-inner"
          />
          <button type="submit" className="hidden" />
        </form>
        
        <div className="flex-1 lg:overflow-y-auto custom-scrollbar lg:pr-2 space-y-4 pb-4">
           {searchMutation.isPending && (
              <div className="py-12 flex flex-col items-center justify-center text-slate-500 space-y-3">
                 <Loader2 className="animate-spin text-[#10b981] w-6 h-6" />
                 <span className="text-sm font-medium">Searching vendors...</span>
              </div>
           )}
           
           {!searchMutation.isPending && !searchMutation.data && (
              <div className="py-12 flex flex-col items-center justify-center text-slate-600 text-center px-4">
                 <Search className="w-10 h-10 mb-3 opacity-20" />
                 <p className="text-sm font-medium text-slate-400">Search for a style number</p>
                 <p className="text-xs mt-1">We'll check S&S and SanMar instantly.</p>
              </div>
           )}

           {searchMutation.data && (
             <>
               {searchMutation.data.vendorErrors.map((err, i) => (
                  <div key={i} className="bg-red-950/30 border border-red-900/50 p-3 rounded-lg text-xs text-red-400 flex gap-2">
                     <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                     <div>
                        <span className="font-bold capitalize">{err.vendor}:</span> {err.error}
                     </div>
                  </div>
               ))}
               {searchMutation.data.vendors.map(v => (
                 <VendorResultCard
                   key={v.lookup.vendor}
                   vendorResult={v}
                   onColorSelect={(color) => addSelection(v.lookup, color)}
                 />
               ))}
             </>
           )}
        </div>
      </div>

      {/* Right Column: Selections */}
      <div className="flex-1 lg:overflow-y-auto custom-scrollbar pb-6 px-1 flex flex-col">
        {selections.length > 0 && (
          <div className="flex justify-between items-center mb-4 sticky top-0 bg-[#020617]/90 backdrop-blur-sm z-10 py-2 border-b border-slate-800">
            <span className="text-sm font-semibold text-slate-300">{selections.length} selected</span>
            <CollectionPicker items={selections.map(s => ({ vendor: s.vendor as any, styleName: s.styleName, colors: [s.colorName] }))}>
              <Button variant="outline" size="sm" className="bg-[#059669]/10 border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 h-8">
                <Star className="w-3 h-3 mr-2" /> Save All to Collection
              </Button>
            </CollectionPicker>
          </div>
        )}
        <div className="space-y-5">
          {selections.length === 0 ? (
             <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-3 pb-20 mt-20">
                <div className="w-16 h-16 rounded-2xl bg-slate-800/50 border border-slate-700 flex items-center justify-center">
                   <div className="w-8 h-8 rounded-full bg-slate-700" />
                </div>
                <p className="text-sm font-medium text-slate-400">No colors selected</p>
                <p className="text-xs">Pick a color from the search results to view live warehouse stock and pricing.</p>
             </div>
          ) : (
             selections.map(sel => (
               <SelectionCard key={sel.id} selection={sel} onRemove={() => removeSelection(sel.id)} />
             ))
          )}
        </div>
      </div>
    </div>
  )
}


function InvoiceLineCard({ state, onPickColor }: { state: InvoiceLineState, onPickColor: (c: VendorColorOffer, lookup: VendorLookupResult) => void }) {
   const line = state.line;
   const isChecking = state.status === "searching" || state.status === "checking_inventory";

   let stockStatus = null;
   let stockMessage = "";

   if (state.status === "done" && state.inventoryResult && state.colorOffer) {
      const needed = line.sizes;
      const missing: string[] = [];

      needed.forEach(n => {
         const invSize = state.inventoryResult!.sizes.find(is => is.size === n.size);
         if (!invSize || !invSize.found) {
            missing.push(n.size);
         } else {
            const totalStock = invSize.warehouses.reduce((acc, w) => acc + w.qty, 0);
            if (totalStock < n.count) {
               missing.push(n.size);
            }
         }
      });

      if (missing.length > 0) {
         stockStatus = "short";
         stockMessage = `Short on sizes: ${missing.join(", ")}`;
      } else {
         stockStatus = "ok";
         stockMessage = "Enough stock across all warehouses";
      }
   }

   return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
         <div className="p-4 sm:p-5 flex flex-col sm:flex-row justify-between items-start gap-4">
            <div className="flex-1">
               <div className="flex items-center gap-2 mb-1">
                  <div className="font-bold text-white text-lg">{line.itemNumber || "No Item #"}</div>
                  {line.color && (
                     <div className="text-sm font-medium text-slate-300 px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
                        {line.color}
                     </div>
                  )}
               </div>
               <div className="text-sm text-slate-500 max-w-2xl">{line.description || "No description"}</div>
               <div className="flex items-center gap-2 mt-3">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Needed:</span>
                  <div className="flex flex-wrap gap-1.5">
                     {line.sizes.length === 0 ? (
                        <span className="text-xs text-slate-600">—</span>
                     ) : (
                        line.sizes.map(s => (
                           <span key={s.size} className="text-[11px] font-mono bg-slate-950 border border-slate-800 text-slate-300 px-1.5 py-0.5 rounded">
                              {s.size} &times; {s.count}
                           </span>
                        ))
                     )}
                  </div>
               </div>
            </div>
            
            <div className="flex-shrink-0 flex sm:flex-col items-center sm:items-end gap-2 w-full sm:w-auto">
               {isChecking && (
                  <Badge variant="outline" className="bg-slate-800 border-slate-700 text-slate-300 py-1">
                     <Loader2 className="w-3 h-3 mr-1.5 animate-spin text-[#10b981]"/> Checking...
                  </Badge>
               )}
               {state.status === "error" && <Badge variant="destructive" className="py-1"><AlertTriangle className="w-3 h-3 mr-1.5"/> {state.error}</Badge>}
               {state.status === "done" && state.error && !state.lookupResult && <Badge variant="destructive" className="py-1"><AlertTriangle className="w-3 h-3 mr-1.5"/> {state.error}</Badge>}
               {stockStatus === "ok" && <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 py-1"><CheckCircle className="w-3 h-3 mr-1.5"/> {stockMessage}</Badge>}
               {stockStatus === "short" && <Badge variant="destructive" className="py-1"><AlertTriangle className="w-3 h-3 mr-1.5"/> {stockMessage}</Badge>}
            </div>
         </div>

         {state.status === "done" && state.lookupResult && !state.colorOffer && (
            <div className="px-5 pb-5 pt-2 border-t border-slate-800 bg-slate-900/50">
               <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  <div className="text-sm font-medium text-amber-500">Auto-match failed. Pick a color for {state.lookupResult.vendor}:</div>
               </div>
               <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto custom-scrollbar">
                  {state.lookupResult.colors.map(c => (
                     <button 
                        key={c.colorName} 
                        onClick={() => onPickColor(c, state.lookupResult!)} 
                        className="flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors group/btn"
                     >
                        {c.swatchImage ? (
                           <img src={c.swatchImage} className="w-5 h-5 rounded-sm shadow-sm" alt="" />
                        ) : (
                           <div className="w-5 h-5 rounded-sm bg-slate-600 shadow-sm" />
                        )}
                        <span className="text-xs font-medium text-slate-200 group-hover/btn:text-white transition-colors">{c.colorName}</span>
                     </button>
                  ))}
               </div>
            </div>
         )}

         {(state.colorOffer || state.inventoryResult) && (
            <div className="px-5 pb-5 pt-4 border-t border-slate-800 bg-[#0f172a]/50 relative">
               <div className="flex items-center justify-between mb-3">
                 <div className="text-xs font-medium text-slate-400 flex items-center gap-2">
                   Matched to <span className="text-[#10b981] font-bold px-1.5 py-0.5 rounded bg-[#10b981]/10 border border-[#10b981]/20">{state.colorOffer?.colorName}</span> at <span className="capitalize font-bold text-slate-300">{state.lookupResult?.vendor}</span>
                 </div>
                 {state.lookupResult && (
                   <CollectionPicker items={[{ vendor: state.lookupResult.vendor as any, styleName: state.lookupResult.styleName || "", colors: state.colorOffer ? [state.colorOffer.colorName] : [] }]}>
                     <Button variant="outline" size="sm" className="bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white h-7 text-[10px] px-2">
                       <Star className="w-3 h-3 mr-1" /> Save
                     </Button>
                   </CollectionPicker>
                 )}
               </div>
               <div className="bg-slate-900 rounded-lg border border-slate-800 p-1 relative">
                  {state.status === "checking_inventory" && (
                     <div className="absolute inset-0 bg-slate-900/50 flex items-center justify-center backdrop-blur-sm z-10 rounded-lg">
                        <div className="flex items-center gap-2 text-sm font-medium text-white bg-slate-800/90 px-4 py-2 rounded-full border border-slate-700 shadow-xl">
                          <Loader2 className="animate-spin w-4 h-4 text-[#10b981]" />
                          Fetching live stock...
                        </div>
                     </div>
                  )}
                  <InventoryGrid sizes={state.colorOffer?.sizes || []} inventory={state.inventoryResult} neededSizes={line.sizes} />
               </div>
            </div>
         )}
      </div>
   )
}

function InvoiceCheckMode() {
  const [visualIdStr, setVisualIdStr] = useState("");
  const [visualId, setVisualId] = useState<number | null>(null);

  const { data: order, isLoading: isOrderLoading, error: orderError } = useGetFinderOrder(
    { visualId: visualId! },
    { query: { enabled: !!visualId, queryKey: getGetFinderOrderQueryKey({ visualId: visualId! }), retry: false } }
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(visualIdStr.trim(), 10);
    if (!isNaN(parsed) && parsed > 0) {
      setVisualId(parsed);
    }
  };

  const [lineStates, setLineStates] = useState<Record<string, InvoiceLineState>>({});
  // Generation guard: a new order (or re-submit) invalidates all in-flight
  // async work from the previous run so stale responses can't write into the
  // fresh lineStates.
  const runIdRef = useRef(0);
  const checkedOrderRef = useRef<string | null>(null);

  useEffect(() => {
    if (!order || checkedOrderRef.current === order.orderId) return;
    checkedOrderRef.current = order.orderId;
    const runId = ++runIdRef.current;

    const initial: Record<string, InvoiceLineState> = {};
    order.lineItems.forEach(line => {
      initial[line.id] = { line, status: "idle" };
    });
    setLineStates(initial);

    const setLine = (id: string, patch: Partial<InvoiceLineState>) => {
      if (runIdRef.current !== runId) return; // stale run — drop the update
      setLineStates(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    };

    const checkAll = async () => {
       for (const line of order.lineItems) {
          if (runIdRef.current !== runId) return;
          if (!line.itemNumber) {
             setLine(line.id, { status: "error", error: "No style number on line" });
             continue;
          }
          setLine(line.id, { status: "searching" });
          try {
             const res = await productSearch({ query: line.itemNumber });
             // Prefer an exact match at either vendor over a fuzzy "closest"
             // guess (SanMar is listed first and could otherwise shadow an
             // exact S&S hit with the wrong garment).
             const bestVendor =
                res.vendors.find(v => v.lookup.found && v.lookup.matchType === "exact") ??
                res.vendors.find(v => v.lookup.found);
             if (!bestVendor) {
                const outage = res.vendorErrors.length > 0
                   ? ` (${res.vendorErrors.map(e => `${e.vendor} unavailable`).join(", ")})`
                   : "";
                setLine(line.id, { status: "error", error: `Style not found${outage ? " — vendor outage" + outage : " at any vendor"}` });
                continue;
             }

             const lookup = bestVendor.lookup;
             const matchColor = lookup.colors.find(c => c.colorName.toLowerCase() === (line.color || "").toLowerCase());

             if (matchColor) {
                setLine(line.id, { status: "checking_inventory", lookupResult: lookup, colorOffer: matchColor });
                const inv = await vendorInventory({
                   vendor: lookup.vendor,
                   style: lookup.styleName || "",
                   styleId: lookup.styleId,
                   catalogColor: matchColor.colorName,
                   sizes: matchColor.sizes.map(s => s.size)
                });
                setLine(line.id, { status: "done", inventoryResult: inv });
             } else {
                setLine(line.id, { status: "done", lookupResult: lookup, error: "Color not matched automatically" });
             }
          } catch (err: any) {
             setLine(line.id, { status: "error", error: err.message || String(err) });
          }
       }
    };
    checkAll();
  }, [order]);

  return (
    <div className="flex flex-col lg:h-full pb-0">
      <div className="mb-6 flex-shrink-0">
        <form onSubmit={handleSubmit} className="flex gap-3 max-w-md">
           <div className="relative flex-1">
             <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4" />
             <Input 
               placeholder="Printavo Invoice #" 
               value={visualIdStr} 
               onChange={e => setVisualIdStr(e.target.value)} 
               className="pl-9 bg-slate-900 border-slate-700 h-10 shadow-inner"
             />
           </div>
           <Button type="submit" className="bg-[#059669] hover:bg-[#047857] text-white font-bold h-10 px-6">Check</Button>
        </form>
      </div>

      <div className="flex-1 lg:overflow-y-auto custom-scrollbar pb-10 lg:pr-2">
        {isOrderLoading && (
           <div className="py-12 flex flex-col items-center justify-center text-slate-500 space-y-3">
              <Loader2 className="animate-spin text-[#10b981] w-8 h-8" />
              <span className="text-sm font-medium text-slate-400">Fetching order details...</span>
           </div>
        )}
        
        {orderError && (
           <div className="bg-red-950/20 border border-red-900/50 p-6 rounded-xl flex flex-col items-center justify-center text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-red-900/20 flex items-center justify-center text-red-500">
                 <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                 <div className="font-bold text-slate-200">Order not found</div>
                 <div className="text-sm text-slate-400 mt-1">Make sure the invoice number is correct and has been synced.</div>
              </div>
           </div>
        )}

        {!visualId && !isOrderLoading && !orderError && (
           <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-4 pb-20">
              <div className="w-16 h-16 rounded-2xl bg-slate-800/50 border border-slate-700 flex items-center justify-center">
                 <Search className="w-8 h-8 text-slate-500" />
              </div>
              <div className="text-center">
                 <p className="text-sm font-medium text-slate-300">Enter an invoice number</p>
                 <p className="text-xs text-slate-500 mt-1 max-w-xs leading-relaxed">We'll scan all line items, find the best matching vendor products, and report live availability for the needed sizes.</p>
              </div>
           </div>
        )}

        {order && (
           <div className="space-y-6">
              <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 flex items-center justify-between">
                 <div>
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                       <span className="text-[#10b981]">#{order.visualId}</span>
                       <span className="text-slate-600 font-normal">&bull;</span>
                       {order.nickname || order.customerCompany || "No Name"}
                    </h2>
                    <div className="text-sm text-slate-500 mt-1">{order.statusName || "Unknown Status"}</div>
                 </div>
                 <div className="text-right text-sm">
                    <div className="font-medium text-slate-300">{order.lineItems.length} lines</div>
                    <div className="text-xs text-slate-500">Auto-checking stock</div>
                 </div>
              </div>

              <div className="space-y-4">
                 {order.lineItems.map(line => (
                    <InvoiceLineCard 
                       key={line.id} 
                       state={lineStates[line.id] ?? { line, status: "idle" }} 
                       onPickColor={async (color, lookup) => {
                         setLineStates(prev => ({ ...prev, [line.id]: { ...prev[line.id], status: "checking_inventory", colorOffer: color } }));
                         try {
                           const inv = await vendorInventory({
                              vendor: lookup.vendor,
                              style: lookup.styleName || "",
                              styleId: lookup.styleId,
                              catalogColor: color.colorName,
                              sizes: color.sizes.map(s => s.size)
                           });
                           setLineStates(prev => ({ ...prev, [line.id]: { ...prev[line.id], status: "done", inventoryResult: inv, error: undefined } }));
                         } catch (err: any) {
                           setLineStates(prev => ({ ...prev, [line.id]: { ...prev[line.id], status: "error", error: err.message || String(err) } }));
                         }
                       }}
                    />
                 ))}
              </div>
           </div>
        )}
      </div>
    </div>
  )
}


function CatalogHealthPanel() {
  const { data: health, isLoading } = useGetCatalogHealth({
    query: {
       refetchInterval: (query) => query.state.data?.refreshActive ? 3000 : false,
       queryKey: getGetCatalogHealthQueryKey()
    }
  });
  
  const qc = useQueryClient();
  const refreshMutation = useTriggerCatalogRefresh({
     mutation: {
       onSuccess: () => qc.invalidateQueries({ queryKey: getGetCatalogHealthQueryKey() })
     }
  });
  const { toast } = useToast();
  
  if (isLoading || !health) return null;

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-0.5">Active Products</span>
          <span className="font-mono text-white text-lg leading-none">{health.activeProducts.toLocaleString()}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-0.5">Colors</span>
          <span className="font-mono text-slate-300 text-lg leading-none">{health.colors.toLocaleString()}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-0.5">Discontinued</span>
          <span className="font-mono text-slate-400 text-lg leading-none">{health.discontinuedProducts.toLocaleString()}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-0.5">Staff Corrections</span>
          <span className="font-mono text-[#10b981] text-lg leading-none">{(health.tagOverrides + health.staffColorFixes).toLocaleString()}</span>
        </div>
      </div>
      
      <div className="flex items-center gap-3">
         {health.refreshActive && (
            <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-full border border-emerald-500/20">
               <RefreshCw size={12} className="animate-spin" />
               Syncing catalog...
            </div>
         )}
         <Button 
           variant="outline" 
           size="sm"
           onClick={() => {
              refreshMutation.mutate(undefined, {
                 onSuccess: () => toast({ title: "Catalog refresh started" }),
                 onError: (err) => toast({ title: "Failed to start refresh", description: String(err), variant: "destructive" })
              })
           }}
           disabled={health.refreshActive || refreshMutation.isPending}
           className="bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white text-xs h-8"
         >
           <RefreshCw size={14} className={`mr-2 ${health.refreshActive ? 'animate-spin' : ''}`} />
           {health.refreshActive ? "Syncing..." : "Refresh Now"}
         </Button>
      </div>
    </div>
  )
}

function TagEditor({ hit }: { hit: CatalogSearchHit }) {
   const qc = useQueryClient();
   const { toast } = useToast();
   const mutation = useSetCatalogTagOverride({
      mutation: {
         onSuccess: () => {
             qc.invalidateQueries({ queryKey: getCatalogSearchQueryKey() });
             qc.invalidateQueries({ queryKey: getGetCatalogHealthQueryKey() });
         },
         onError: (err) => toast({ title: "Failed to update tags", description: String(err), variant: "destructive" })
      }
   });
   
   const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const val = new FormData(e.currentTarget).get("tags") as string;
      if (!val) return;
      const tags = val.split(",").map(t => t.trim()).filter(Boolean);
      mutation.mutate({ data: { vendor: hit.vendor, styleName: hit.styleName, addTags: tags, removeTags: [] } });
      e.currentTarget.reset();
   }
   
   const handleRemove = (tag: string) => {
      mutation.mutate({ data: { vendor: hit.vendor, styleName: hit.styleName, addTags: [], removeTags: [tag] } });
   }

   return (
     <div className="flex flex-wrap gap-1.5 items-center mt-2">
       {hit.tags.map(t => (
         <Badge key={t} variant="secondary" className="text-[10px] bg-slate-800 text-slate-300 pr-1 border border-slate-700">
           {t}
           <button onClick={() => handleRemove(t)} className="ml-1 hover:text-white focus:outline-none" disabled={mutation.isPending}>
             <X size={10} />
           </button>
         </Badge>
       ))}
       <Popover>
         <PopoverTrigger asChild>
           <button className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/50 border border-slate-700/50 text-slate-400 hover:text-slate-200">
             + Add Tag
           </button>
         </PopoverTrigger>
         <PopoverContent className="w-64 p-3 bg-slate-900 border-slate-700" side="top">
           <form onSubmit={handleAdd} className="flex gap-2">
             <Input name="tags" placeholder="cool, summer, basics" className="h-8 text-xs bg-slate-950 border-slate-800" autoFocus />
             <Button type="submit" size="sm" className="h-8 text-xs bg-[#059669] text-white" disabled={mutation.isPending}>Add</Button>
           </form>
         </PopoverContent>
       </Popover>
     </div>
   )
}

function ColorFamilyEditor({ color, availableFamilies }: { color: CatalogMatchedColor, availableFamilies: string[] }) {
   const qc = useQueryClient();
   const { toast } = useToast();
   const mutation = useSetCatalogColorFamily({
      mutation: {
         onSuccess: () => {
             qc.invalidateQueries({ queryKey: getCatalogSearchQueryKey() });
             qc.invalidateQueries({ queryKey: getGetCatalogHealthQueryKey() });
         },
         onError: (err) => toast({ title: "Failed to update color family", description: String(err), variant: "destructive" })
      }
   });

   const [open, setOpen] = useState(false);
   const [selected, setSelected] = useState<string[]>(color.families || []);

   const handleSave = () => {
      mutation.mutate({ data: { colorName: color.colorName, families: selected } }, {
         onSuccess: () => setOpen(false)
      });
   };

   return (
     <Popover open={open} onOpenChange={setOpen}>
       <PopoverTrigger asChild>
         <button className="flex flex-wrap gap-1 hover:opacity-80 transition-opacity mt-1">
           {color.families.length > 0 ? (
             color.families.map(f => (
                <span key={f} className="text-[9px] bg-slate-800 border border-slate-700 text-slate-400 px-1 rounded-sm leading-tight">
                  {f}
                </span>
             ))
           ) : (
             <span className="text-[9px] text-slate-600 border border-dashed border-slate-700 px-1 rounded-sm">Uncategorized</span>
           )}
         </button>
       </PopoverTrigger>
       <PopoverContent className="w-64 p-4 bg-slate-900 border-slate-700" side="top">
          <div className="text-xs font-semibold text-slate-300 mb-3 flex items-center justify-between">
            <span>Families for {color.colorName}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto custom-scrollbar mb-4 pr-1">
             {availableFamilies.map(f => (
                <label key={f} className="flex items-center gap-2 text-xs text-slate-300">
                   <Checkbox 
                      checked={selected.includes(f)}
                      onCheckedChange={(checked) => {
                         if (checked) setSelected(p => [...p, f]);
                         else setSelected(p => p.filter(x => x !== f));
                      }}
                      className="border-slate-600 data-[state=checked]:bg-[#10b981] data-[state=checked]:border-[#10b981]"
                   />
                   <span className="truncate" title={f}>{f}</span>
                </label>
             ))}
          </div>
          <Button onClick={handleSave} size="sm" className="w-full h-8 bg-[#059669] hover:bg-[#047857] text-white" disabled={mutation.isPending}>
            Save
          </Button>
       </PopoverContent>
     </Popover>
   )
}

import { ProductPhotoViewer } from "@/components/product-finder/ProductPhotoViewer";

function CatalogHitCard({ hit, onSelectStyle, availableFamilies }: { hit: CatalogSearchHit, onSelectStyle: (styleName: string) => void, availableFamilies: string[] }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerColorName, setViewerColorName] = useState<string | undefined>();
  const [showFullDesc, setShowFullDesc] = useState(false);
  
  const description = hit.description?.trim();

  const openViewer = (colorName?: string) => {
    setViewerColorName(colorName);
    setViewerOpen(true);
  };

  return (
    <div className="bg-slate-900/40 hover:bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition-colors rounded-xl p-5 shadow-sm group">
      <div className="flex flex-col sm:flex-row gap-5">
         {hit.styleImage ? (
            <button 
              onClick={() => openViewer()}
              aria-label="View product photos"
              className="w-full sm:w-32 h-32 rounded-lg bg-white border border-slate-700 flex items-center justify-center p-2 flex-shrink-0 cursor-pointer hover:border-slate-500 hover:ring-2 hover:ring-[#10b981]/50 transition-all focus:outline-none focus:ring-2 focus:ring-[#10b981]"
            >
               <img src={hit.styleImage} className="max-w-full max-h-full object-contain" alt={hit.title || hit.styleName} />
            </button>
         ) : (
            <div className="w-full sm:w-32 h-32 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0 border border-slate-700">
               <span className="text-xs text-slate-500">No Image</span>
            </div>
         )}
         
         <div className="flex-1 min-w-0">
            <div className="flex justify-between items-start gap-4">
               <div>
                 <div className="flex items-center gap-2 mb-1">
                   <div className="font-bold text-white capitalize text-lg">{hit.vendor}</div>
                   <div className="text-sm font-bold text-[#10b981] bg-[#10b981]/10 px-2 py-0.5 rounded border border-[#10b981]/20">{hit.styleName}</div>
                   {hit.brand && <div className="text-xs font-medium text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{hit.brand}</div>}
                 </div>
                 <div className="text-sm text-slate-300 mb-2 truncate max-w-xl">{hit.title}</div>
               </div>
               
               <div className="text-right flex-shrink-0">
                  <div className="text-sm font-mono font-bold text-[#10b981]">
                    {hit.priceMin != null && hit.priceMax != null && hit.priceMin !== hit.priceMax 
                       ? `$${hit.priceMin.toFixed(2)} - $${hit.priceMax.toFixed(2)}`
                       : hit.priceMin != null ? `$${hit.priceMin.toFixed(2)}` : "No price"
                    }
                  </div>
                  <div className="text-[10px] uppercase text-slate-500 mt-1 font-bold">Dealer Cost</div>
               </div>
            </div>
            
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-3">
               {hit.category && <span>{hit.category}</span>}
               {hit.category && <span>&bull;</span>}
               {hit.sizes.length > 0 && (
                 <>
                   <span>{hit.sizes.length} sizes ({hit.sizes[0]} - {hit.sizes[hit.sizes.length-1]})</span>
                   <span>&bull;</span>
                 </>
               )}
               <span>{hit.colorCount} colors available</span>
            </div>

            {description ? (
               <div className="mb-4 text-sm text-slate-400">
                  <p className={`whitespace-pre-wrap ${!showFullDesc ? 'line-clamp-2' : ''}`}>
                    {description}
                  </p>
                  {description && (
                    <button 
                      onClick={() => setShowFullDesc(!showFullDesc)}
                      className="text-xs font-medium text-slate-300 hover:text-white mt-1 transition-colors"
                    >
                      {showFullDesc ? "Read less" : "Show more"}
                    </button>
                  )}
               </div>
            ) : (
               <div className="mb-4 text-sm text-slate-500 italic">
                 Description unavailable
               </div>
            )}
            
            <TagEditor hit={hit} />
            
            {hit.matchedColors.length > 0 && (
               <div className="mt-4 pt-4 border-t border-slate-800/50">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Matched Colors</div>
                  <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto custom-scrollbar">
                     {hit.matchedColors.map(c => (
                        <div key={c.colorName} className="flex items-start gap-2 bg-slate-950 border border-slate-800 rounded p-2 pr-3 min-w-[120px]">
                           <button 
                              onClick={() => openViewer(c.colorName)}
                              aria-label={`View ${c.colorName}`}
                              className="focus:outline-none flex-shrink-0 group/swatch hover:ring-2 hover:ring-[#10b981]/50 rounded-sm transition-all"
                           >
                             {c.swatchImage ? (
                                <img src={c.swatchImage} className="w-6 h-6 rounded-sm shadow-sm flex-shrink-0 bg-slate-200" alt="" />
                             ) : (
                                <div className="w-6 h-6 rounded-sm bg-slate-700 shadow-sm flex-shrink-0" />
                             )}
                           </button>
                           <div className="flex flex-col justify-center min-w-0">
                              <button 
                                onClick={() => openViewer(c.colorName)}
                                aria-label={`View ${c.colorName}`}
                                className="text-[11px] font-medium text-slate-300 hover:text-white leading-none mb-1 truncate text-left focus:outline-none"
                              >
                                {c.colorName}
                              </button>
                              <ColorFamilyEditor color={c} availableFamilies={availableFamilies} />
                           </div>
                        </div>
                     ))}
                  </div>
               </div>
            )}
            
            <div className="mt-4 pt-4 border-t border-slate-800/50 flex justify-end gap-2">
               <CollectionPicker items={[{ vendor: hit.vendor, styleName: hit.styleName, colors: hit.matchedColors.map(c => c.colorName) }]}>
                 <Button variant="outline" size="sm" className="bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white h-8">
                   <Star className="w-3 h-3 mr-2" /> Save to Collection
                 </Button>
               </CollectionPicker>
               <Button 
                  onClick={() => onSelectStyle(hit.styleName)} 
                  className="bg-slate-800 hover:bg-slate-700 text-white text-xs h-8"
               >
                  Check Live Stock & Pricing &rarr;
               </Button>
            </div>
         </div>
      </div>

      <ProductPhotoViewer 
         open={viewerOpen} 
         onOpenChange={setViewerOpen} 
         hit={hit} 
         initialColorName={viewerColorName} 
      />
    </div>
  )
}

function CatalogSearchMode({ onSelectStyle }: { onSelectStyle: (styleName: string) => void }) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState(q);
  
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const [vendor, setVendor] = useState<string>("all");
  const [brand, setBrand] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [colorFamily, setColorFamily] = useState<string>("all");
  
  const [priceMinStr, setPriceMinStr] = useState("");
  const [priceMaxStr, setPriceMaxStr] = useState("");
  
  const [debouncedPriceMin, setDebouncedPriceMin] = useState("");
  const [debouncedPriceMax, setDebouncedPriceMax] = useState("");
  
  useEffect(() => {
    const t = setTimeout(() => {
       setDebouncedPriceMin(priceMinStr);
       setDebouncedPriceMax(priceMaxStr);
    }, 500);
    return () => clearTimeout(t);
  }, [priceMinStr, priceMaxStr]);

  const { data: filters } = useGetCatalogFilters({
     query: { queryKey: getGetCatalogFiltersQueryKey() }
  });

  const { data: health } = useGetCatalogHealth({
    query: {
      refetchInterval: (query) => query.state.data?.refreshActive ? 3000 : false,
      queryKey: getGetCatalogHealthQueryKey()
    }
  });

  const searchParams = useMemo(() => {
     const p: any = { q: debouncedQ };
     if (vendor !== "all") p.vendor = vendor;
     if (brand !== "all") p.brand = brand;
     if (category !== "all") p.category = category;
     if (colorFamily !== "all") p.colorFamily = colorFamily;
     const pMin = parseFloat(debouncedPriceMin);
     if (!isNaN(pMin)) p.priceMin = pMin;
     const pMax = parseFloat(debouncedPriceMax);
     if (!isNaN(pMax)) p.priceMax = pMax;
     return p;
  }, [debouncedQ, vendor, brand, category, colorFamily, debouncedPriceMin, debouncedPriceMax]);

  const { data: searchResult, isFetching } = useCatalogSearch(searchParams, {
     query: {
        enabled: !!debouncedQ.trim(),
        queryKey: getCatalogSearchQueryKey(searchParams)
     }
  });
  
  return (
    <div className="flex flex-col lg:h-full lg:overflow-hidden">
       <div className="flex-shrink-0 mb-6">
         <CatalogHealthPanel />
       </div>
       
       <div className="flex-shrink-0 mb-6 space-y-4">
         <div className="relative">
           <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
           <Input 
             placeholder="Search natural language (e.g. 'forest green polos', 'women\'s crop tees')..." 
             value={q}
             onChange={e => setQ(e.target.value)}
             className="pl-12 bg-slate-900 border-slate-700 h-12 text-base shadow-inner rounded-xl"
             autoFocus
           />
         </div>
         
         <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Select value={vendor} onValueChange={setVendor}>
              <SelectTrigger className="bg-slate-900 border-slate-800 text-slate-300 h-9 text-xs"><SelectValue placeholder="Vendor" /></SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800">
                <SelectItem value="all">All Vendors</SelectItem>
                <SelectItem value="sanmar">SanMar</SelectItem>
                <SelectItem value="ss">S&S Activewear</SelectItem>
              </SelectContent>
            </Select>
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger className="bg-slate-900 border-slate-800 text-slate-300 h-9 text-xs"><SelectValue placeholder="Brand" /></SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800 max-h-64">
                <SelectItem value="all">All Brands</SelectItem>
                {filters?.brands.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="bg-slate-900 border-slate-800 text-slate-300 h-9 text-xs"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800 max-h-64">
                <SelectItem value="all">All Categories</SelectItem>
                {filters?.categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={colorFamily} onValueChange={setColorFamily}>
              <SelectTrigger className="bg-slate-900 border-slate-800 text-slate-300 h-9 text-xs"><SelectValue placeholder="Color Family" /></SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800 max-h-64">
                <SelectItem value="all">All Colors</SelectItem>
                {filters?.colorFamilies.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Input placeholder="Min $" value={priceMinStr} onChange={e => setPriceMinStr(e.target.value)} className="bg-slate-900 border-slate-800 h-9 text-xs px-2" />
              <span className="text-slate-600">-</span>
              <Input placeholder="Max $" value={priceMaxStr} onChange={e => setPriceMaxStr(e.target.value)} className="bg-slate-900 border-slate-800 h-9 text-xs px-2" />
            </div>
         </div>
       </div>
       
       <div className="flex-1 lg:overflow-y-auto custom-scrollbar pb-10">
          {(() => {
             if (health && health.activeProducts === 0 && !health.refreshActive) {
                return (
                   <div className="py-20 flex flex-col items-center justify-center text-center">
                      <div className="w-20 h-20 bg-slate-800/50 rounded-full flex items-center justify-center mb-6 border border-slate-700">
                        <Search className="w-10 h-10 text-slate-500" />
                      </div>
                      <h3 className="text-xl font-bold text-white mb-2">Catalog is empty</h3>
                      <p className="text-slate-400 max-w-md text-sm mb-6">
                         The product catalog imports nightly. You can manually trigger a sync in the panel above to fetch the latest products from SanMar and S&S Activewear.
                      </p>
                   </div>
                )
             }
             
             if (!debouncedQ.trim()) {
                return (
                   <div className="py-20 flex flex-col items-center justify-center text-center px-4">
                      <div className="w-16 h-16 bg-slate-800/30 rounded-2xl flex items-center justify-center mb-4 border border-slate-800">
                        <Search className="w-8 h-8 text-slate-500 opacity-50" />
                      </div>
                      <p className="text-sm font-medium text-slate-300">Describe what you're looking for</p>
                      <p className="text-xs text-slate-500 mt-2 max-w-sm">
                        Search across tens of thousands of products. We match on style numbers, descriptions, tags, and colors.
                      </p>
                   </div>
                )
             }
             
             if (isFetching && !searchResult) {
                return (
                   <div className="py-20 flex flex-col items-center justify-center text-slate-500 space-y-3">
                      <Loader2 className="animate-spin text-[#10b981] w-8 h-8" />
                      <span className="text-sm font-medium">Searching catalog...</span>
                   </div>
                )
             }
             
             if (searchResult && searchResult.hits.length === 0) {
                return (
                   <div className="py-12 flex flex-col items-center justify-center text-slate-500">
                      <p className="text-sm font-medium">No products found matching "{debouncedQ}"</p>
                   </div>
                )
             }
             
             if (searchResult) {
                return (
                   <div className="space-y-4">
                      {isFetching && (
                         <div className="absolute right-8 top-1/2 flex items-center text-xs text-slate-500">
                            <Loader2 className="w-3 h-3 mr-1 animate-spin text-[#10b981]" /> updating...
                         </div>
                      )}
                      <div className="text-xs text-slate-500 mb-2">Found {searchResult.total} matches</div>
                      {searchResult.hits.map(hit => (
                         <CatalogHitCard 
                           key={`${hit.vendor}-${hit.styleName}`} 
                           hit={hit} 
                           onSelectStyle={onSelectStyle}
                           availableFamilies={filters?.colorFamilies || []}
                         />
                      ))}
                   </div>
                )
             }
             
             return null;
          })()}
       </div>
    </div>
  )
}

export default function ProductFinder() {
  const [activeTab, setActiveTab] = useState("catalog");
  const [styleQuery, setStyleQuery] = useState("");
  
  const searchString = useSearch();
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const style = params.get("style");
    const tabParam = params.get("tab");

    if (tabParam === "cap-america") {
      setActiveTab("cap-america");
    }

    if (style) {
      setStyleQuery(style);
      setActiveTab("search");
      // clear the URL param so it doesn't re-trigger on remount
      window.history.replaceState({}, '', '/product-finder');
    }
  }, [searchString]);

  const handleSelectStyle = (styleName: string) => {
    setStyleQuery(styleName);
    setActiveTab("search");
  };

  return (
    <AppShell>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col min-h-full lg:h-full lg:overflow-hidden bg-[#020617]">
        <div className="flex-shrink-0 border-b border-slate-800 px-6 pt-6 pb-0 z-10 relative">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-lg bg-[#059669]/20 border border-[#059669]/30 flex items-center justify-center text-[#10b981] shadow-inner shadow-[#10b981]/10">
               <Search size={20} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">Product Finder</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                {activeTab === "cap-america"
                  ? "Static catalog sample for Cap America (Inventory unavailable)"
                  : "Catalog & Live stock from SanMar and S&S Activewear"}
              </p>
            </div>
          </div>

          <TabsList className="bg-slate-900 border border-slate-800 p-1 w-full max-w-2xl h-auto grid grid-cols-2 sm:grid-cols-4 rounded-lg mb-0 relative top-[1px]">
            <TabsTrigger value="catalog" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-white font-medium text-xs">Catalog Search</TabsTrigger>
            <TabsTrigger value="search" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-white font-medium text-xs">Search by Style</TabsTrigger>
            <TabsTrigger value="invoice" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-white font-medium text-xs">Check Invoice</TabsTrigger>
            <TabsTrigger value="cap-america" className="rounded-md data-[state=active]:bg-slate-800 data-[state=active]:text-white font-medium text-xs">Cap America Sample</TabsTrigger>
          </TabsList>
        </div>
        
        <div className="flex-1 lg:overflow-hidden">
           <TabsContent value="catalog" className="m-0 lg:h-full border-none outline-none p-4 lg:p-6">
             <CatalogSearchMode onSelectStyle={handleSelectStyle} />
           </TabsContent>

           <TabsContent value="search" className="m-0 lg:h-full border-none outline-none p-4 lg:p-6">
             <StyleSearchMode initialQuery={styleQuery} onClearInitialQuery={() => setStyleQuery("")} />
           </TabsContent>
           
           <TabsContent value="invoice" className="m-0 lg:h-full border-none outline-none p-4 lg:p-6">
             <InvoiceCheckMode />
           </TabsContent>

           <TabsContent value="cap-america" className="m-0 lg:h-full border-none outline-none p-4 lg:p-6">
             <CapAmericaSampleCatalog />
           </TabsContent>
        </div>
      </Tabs>
    </AppShell>
  );
}
