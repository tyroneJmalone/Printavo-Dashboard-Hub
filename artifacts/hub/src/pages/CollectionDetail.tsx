import { useState, useEffect, useRef } from "react";
import { useParams, Link, useLocation } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, User, Edit2, Search, AlertTriangle, Link as LinkIcon, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  useGetCollection,
  getGetCollectionQueryKey,
  useUpdateCollection,
  useUpdateCollectionItem,
  useRemoveCollectionItem,
  useListDirectoryCustomers,
  getListDirectoryCustomersQueryKey,
  CollectionItemDetail,
  PaletteColorSuggestion
} from "@workspace/api-client-react";

function CustomerPicker({ value, onSelect }: { value: string | null; onSelect: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useListDirectoryCustomers({ search: debouncedQ }, {
    query: { enabled: open, placeholderData: keepPreviousData, queryKey: getListDirectoryCustomersQueryKey({ search: debouncedQ }) }
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700">
          <LinkIcon className="w-3 h-3 mr-2" />
          {value ? "Re-link Customer" : "Link Customer"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0 bg-slate-900 border-slate-700">
        <div className="p-2 border-b border-slate-800 flex items-center gap-2">
           <Search className="w-4 h-4 text-slate-500 flex-shrink-0" />
           <Input 
             value={q} 
             onChange={e => setQ(e.target.value)} 
             placeholder="Search customers..." 
             className="h-8 text-xs bg-slate-950 border-slate-800"
             autoFocus
           />
           {isFetching && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
        </div>
        <div className="max-h-64 overflow-y-auto custom-scrollbar p-2 flex flex-col gap-1">
           {value && (
             <Button variant="ghost" size="sm" onClick={() => { onSelect(null); setOpen(false); }} className="justify-start text-red-400 hover:text-red-300 hover:bg-red-500/10">
               Unlink customer
             </Button>
           )}
           {data?.customers.length === 0 ? (
             <div className="p-4 text-center text-xs text-slate-500">No matching customers</div>
           ) : (
             data?.customers.map(c => (
               <Button key={c.printavoId} variant="ghost" size="sm" onClick={() => { onSelect(c.printavoId); setOpen(false); }} className="justify-start text-xs text-slate-300 hover:bg-slate-800 text-left h-auto py-2 flex flex-col items-start gap-0.5">
                 <span className="font-bold truncate w-full">{c.displayName}</span>
                 {c.contactEmail && <span className="text-[10px] text-slate-500 truncate w-full">{c.contactEmail}</span>}
               </Button>
             ))
           )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ItemCard({ item, collectionId }: { item: CollectionItemDetail; collectionId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [colorsStr, setColorsStr] = useState(item.colors.join(", "));
  const [noteStr, setNoteStr] = useState(item.note || "");
  const [isEditing, setIsEditing] = useState(false);

  const updateMut = useUpdateCollectionItem({
    mutation: {
      onSuccess: () => {
        toast({ title: "Item updated" });
        qc.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
        setIsEditing(false);
      },
      onError: (err) => toast({ title: "Failed to update", description: String(err), variant: "destructive" })
    }
  });

  const removeMut = useRemoveCollectionItem({
    mutation: {
      onSuccess: () => {
        toast({ title: "Item removed" });
        qc.invalidateQueries({ queryKey: getGetCollectionQueryKey(collectionId) });
      },
      onError: (err) => toast({ title: "Failed to remove", description: String(err), variant: "destructive" })
    }
  });

  const handleSave = () => {
    const parsedColors = colorsStr.split(",").map(c => c.trim()).filter(Boolean);
    updateMut.mutate({
      id: collectionId,
      itemId: item.id,
      data: {
        colors: parsedColors,
        note: noteStr.trim() || null
      }
    });
  };

  const handleRemove = () => {
    if (window.confirm("Remove this item from the collection?")) {
      removeMut.mutate({ id: collectionId, itemId: item.id });
    }
  };

  // Decide what image and details to show.
  // We prefer snapshot product details to reflect what was matched,
  // falling back to catalog detail if it's a legacy item.
  const snap = item.paletteMatchSnapshot;
  const displayBrand = snap?.product.brand || item.brand;
  const displayTitle = snap?.product.title || item.title;
  let imgUrl = snap?.product.styleImage || item.styleImage;

  if (item.vendor === 'ss' && imgUrl && !imgUrl.startsWith('http')) {
    imgUrl = imgUrl.startsWith('/') ? `https://www.ssactivewear.com${imgUrl}` : `https://www.ssactivewear.com/${imgUrl}`;
  }

  const cost = item.priceMax ?? item.priceMin ?? 0;
  const label = `${displayBrand || ""} ${displayTitle || item.styleName}`.trim();

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row gap-6 shadow-sm">
       <div className="w-full md:w-40 h-40 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center p-3 flex-shrink-0 relative overflow-hidden">
          {imgUrl ? (
             <img src={imgUrl} className="max-w-full max-h-full object-contain mix-blend-screen" alt="" />
          ) : (
             <span className="text-xs text-slate-500">No Image</span>
          )}
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-slate-950/80 border border-slate-800 text-[10px] font-bold text-slate-300 uppercase tracking-wider backdrop-blur-sm">
             {item.vendor}
          </div>
       </div>

       <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex justify-between items-start gap-4 mb-3">
             <div>
                <div className="flex items-center gap-2 mb-1">
                   <h3 className="font-bold text-white text-xl tracking-tight">{item.styleName}</h3>
                   {displayBrand && <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{displayBrand}</span>}
                </div>
                 <div className="text-sm text-slate-400 truncate max-w-xl">{displayTitle}</div>
                 {snap?.product.description && (
                   <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">{snap.product.description}</p>
                 )}

                {snap && (
                  <div className="text-[11px] text-slate-500 mt-2 font-mono bg-slate-950 inline-flex px-2 py-1 rounded border border-slate-800">
                    Sizes: <span className="text-slate-300 ml-1">{snap.product.sizeRange || snap.product.sizes.join(', ')}</span>
                  </div>
                )}
             </div>
             <div className="text-right flex-shrink-0 bg-slate-950/50 p-2 rounded-lg border border-slate-800">
                <div className="text-sm font-mono font-bold text-emerald-400">
                  {item.priceMin != null && item.priceMax != null && item.priceMin !== item.priceMax 
                     ? `$${item.priceMin.toFixed(2)} - $${item.priceMax.toFixed(2)}`
                     : item.priceMin != null ? `$${item.priceMin.toFixed(2)}` : "No price"
                  }
                </div>
                <div className="text-[10px] uppercase text-slate-500 mt-1 font-bold">Cost Range</div>
             </div>
          </div>

          {(item.discontinued || !item.inCatalog) && (
            <div className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 mb-4 w-fit">
               <AlertTriangle size={12} />
               {item.discontinued ? "Discontinued by Vendor" : "Not found in local catalog"}
            </div>
          )}

          {isEditing ? (
             <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-4 mb-5">
                <div>
                   <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Chosen Colors (comma separated)</label>
                   <Input value={colorsStr} onChange={e => setColorsStr(e.target.value)} className="h-9 text-sm bg-slate-900 border-slate-700 focus-visible:ring-emerald-500/50" placeholder="e.g. Black, Navy, True Red" />
                </div>
                <div>
                   <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Note for this item</label>
                   <Textarea value={noteStr} onChange={e => setNoteStr(e.target.value)} className="text-sm bg-slate-900 border-slate-700 min-h-[80px] focus-visible:ring-emerald-500/50" placeholder="Special instructions..." />
                </div>
                <div className="flex gap-2 justify-end pt-2 border-t border-slate-800/50">
                   <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); setColorsStr(item.colors.join(", ")); setNoteStr(item.note || ""); }} className="h-8">Cancel</Button>
                   <Button size="sm" onClick={handleSave} disabled={updateMut.isPending} className="h-8 bg-emerald-600 hover:bg-emerald-500 text-white px-6">Save Changes</Button>
                </div>
             </div>
          ) : (
             <div className="mb-5 space-y-3">
                {/* Render each color, integrating snapshot evidence if present */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                   {item.colors.length > 0 ? (
                      item.colors.map(c => {
                          const match = snap?.matches.find((m: PaletteColorSuggestion) => m.colorName === c);

                         if (match) {
                           return (
                             <div key={c} className="bg-slate-950 border border-slate-800 rounded-lg p-3 relative shadow-sm">
                               <div className="flex gap-3">
                                 {match.swatchImage || match.productImage ? (
                                   <img src={match.swatchImage || match.productImage || ''} alt="" className="w-10 h-10 rounded bg-slate-900 border border-slate-800 object-cover flex-shrink-0" />
                                 ) : (
                                   <div className="w-10 h-10 rounded bg-slate-900 border border-slate-800 flex items-center justify-center text-[8px] text-slate-600">No Img</div>
                                 )}
                                 <div className="flex-1 min-w-0 pr-6">
                                   <div className="font-bold text-slate-200 text-sm truncate">{c}</div>
                                   <div className="flex items-center gap-1.5 mt-0.5">
                                      <div className="w-2.5 h-2.5 rounded-full border border-white/10" style={{ backgroundColor: match.matchedCustomer.hex || '#000' }} />
                                      <span className="text-[10px] text-slate-400 truncate">{match.matchedCustomer.role}</span>
                                   </div>
                                 </div>
                               </div>

                               <div className="absolute top-3 right-3 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-emerald-400">
                                 {match.score}
                               </div>

                               <div className="mt-3 space-y-1.5 pt-2 border-t border-slate-800/50">
                                 <div className="flex flex-wrap gap-1.5">
                                   <Badge variant="outline" className="text-[8px] uppercase tracking-wider py-0 px-1 bg-slate-900 border-slate-700 text-slate-400">{match.matchMethod.replace('_', ' ')}</Badge>
                                   <Badge variant="outline" className={cn(
                                     "text-[8px] uppercase tracking-wider py-0 px-1 border",
                                     match.confidence === 'high' ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" :
                                     match.confidence === 'medium' ? "text-amber-400 border-amber-500/30 bg-amber-500/10" :
                                     "text-slate-400 border-slate-700 bg-slate-800"
                                   )}>{match.confidence}</Badge>
                                 </div>

                                  <p className="text-[9px] leading-relaxed text-slate-500">{match.reason}</p>

                                  {match.evidence && (
                                    <div className="space-y-1 rounded bg-slate-900/50 p-1.5 text-[9px] text-slate-400">
                                      <div className="flex justify-between items-center">
                                        <span>{match.deltaE != null ? <>Delta E: <strong className="text-slate-300">{match.deltaE.toFixed(1)}</strong></> : 'Web-swatch evidence'}</span>
                                        <span className={match.evidence.status === 'measured' ? 'text-emerald-400/80' : 'text-amber-400/80'}>{match.evidence.status}</span>
                                      </div>
                                      {match.evidence.method && (
                                        <div className="truncate text-slate-500" title={match.evidence.method}>{match.evidence.method.replaceAll('_', ' ')}</div>
                                      )}
                                      <div className="flex flex-wrap gap-x-2 text-slate-600">
                                        {match.evidence.algorithmVersion && <span>{match.evidence.algorithmVersion}</span>}
                                        {match.evidence.measuredAt && <span>{new Date(match.evidence.measuredAt).toLocaleString()}</span>}
                                        {match.evidence.sourceSwatchUrl && (
                                          <a href={match.evidence.sourceSwatchUrl} target="_blank" rel="noreferrer" className="text-emerald-500 hover:underline">Source swatch</a>
                                        )}
                                      </div>
                                   </div>
                                 )}

                                 <div className="flex justify-between text-[9px] pt-1">
                                   <div className="flex flex-col">
                                     <span className="text-slate-500">Garment PMS</span>
                                     <span className="font-mono text-slate-300">{match.garmentPantoneCode ?? "Not provided."}</span>
                                   </div>
                                   {match.matchedCustomer.pantoneCode && (
                                     <div className="flex flex-col text-right">
                                       <span className="text-slate-500">Brand PMS</span>
                                       <span className="font-mono text-slate-300">{match.matchedCustomer.pantoneCode}</span>
                                     </div>
                                   )}
                                 </div>
                               </div>
                             </div>
                           );
                         }

                         // Legacy display without snapshot
                         return (
                           <div key={c} className="flex items-center gap-2 bg-slate-950 border border-slate-800 text-slate-300 px-3 py-2 rounded-lg">
                             <div className="w-3 h-3 rounded-full bg-slate-800 border border-slate-700" />
                             <span className="text-sm font-medium">{c}</span>
                           </div>
                         );
                      })
                   ) : (
                      <span className="text-xs text-slate-500 italic p-2 border border-slate-800 border-dashed rounded">No colors selected</span>
                   )}
                </div>
                {item.note && <div className="text-sm text-slate-300 bg-slate-950 p-3 rounded-lg border border-slate-800 leading-relaxed shadow-sm">"{item.note}"</div>}
             </div>
          )}

          <div className="mt-auto pt-4 border-t border-slate-800/50 flex flex-wrap items-center justify-between gap-4">
             <div className="flex gap-2">
                {!isEditing && (
                   <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)} className="h-8 text-xs text-slate-400 hover:text-white hover:bg-slate-800">
                     <Edit2 className="w-3 h-3 mr-1.5" /> Edit details
                   </Button>
                )}
                <Button variant="ghost" size="sm" onClick={handleRemove} disabled={removeMut.isPending} className="h-8 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/30">
                  <Trash2 className="w-3 h-3 mr-1.5" /> Remove
                </Button>
             </div>
             <div className="flex gap-2">
                <Link href={`/product-finder?style=${encodeURIComponent(item.styleName)}`}>
                   <Button variant="outline" size="sm" className="h-8 text-xs bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700">
                     Check live stock
                   </Button>
                </Link>
                <Link href={`/price-calculator?garmentCost=${cost}&label=${encodeURIComponent(label)}`}>
                   <Button variant="outline" size="sm" className="h-8 text-xs bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20">
                     Send to Calculator
                   </Button>
                </Link>
             </div>
          </div>
       </div>
    </div>
  );
}

export default function CollectionDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const [_, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: collection, isLoading, error } = useGetCollection(id, {
    query: { enabled: !!id, queryKey: getGetCollectionQueryKey(id) }
  });

  const updateMut = useUpdateCollection({
    mutation: {
      onSuccess: () => {
        toast({ title: "Collection updated" });
        qc.invalidateQueries({ queryKey: getGetCollectionQueryKey(id) });
        setIsEditingName(false);
      },
      onError: (err) => toast({ title: "Failed to update", description: String(err), variant: "destructive" })
    }
  });

  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  
  const [notesInput, setNotesInput] = useState("");
  const notesRef = useRef(notesInput);
  
  // Sync init state
  const initializedId = useRef<string | null>(null);
  useEffect(() => {
    if (collection && initializedId.current !== id) {
      initializedId.current = id;
      setNotesInput(collection.notes || "");
      notesRef.current = collection.notes || "";
    }
  }, [collection, id]);

  const handleNameSave = () => {
    if (nameInput.trim() && nameInput !== collection?.name) {
      updateMut.mutate({ id, data: { name: nameInput.trim() } });
    } else {
      setIsEditingName(false);
    }
  };

  const handleNotesBlur = () => {
    if (notesInput !== notesRef.current) {
      updateMut.mutate({ id, data: { notes: notesInput || null } });
      notesRef.current = notesInput;
    }
  };

  if (isLoading) {
    return (
      <AppShell>
        <div className="py-20 flex justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        </div>
      </AppShell>
    );
  }

  if (error || !collection) {
    return (
      <AppShell>
        <div className="py-20 text-center text-slate-500">
          <p className="mb-4">Collection not found.</p>
          <Link href="/collections">
            <Button variant="outline" size="sm">
              <ArrowLeft size={14} className="mr-1.5" /> Back to Collections
            </Button>
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-slate-950 border-b border-slate-800 px-6 py-6 shadow-sm">
          <div className="mb-4">
            <Link href="/collections" className="inline-flex items-center text-xs font-semibold text-slate-500 hover:text-slate-300 transition-colors">
              <ArrowLeft size={14} className="mr-1" /> Back to Collections
            </Link>
          </div>
          
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
            <div className="flex-1">
               {isEditingName ? (
                 <div className="flex items-center gap-2 mb-3">
                    <Input autoFocus value={nameInput} onChange={e => setNameInput(e.target.value)} className="h-10 bg-slate-900 border-slate-700 text-lg font-bold max-w-sm focus-visible:ring-emerald-500/50" />
                    <Button size="sm" onClick={handleNameSave} className="h-10 bg-emerald-600 hover:bg-emerald-500 text-white px-4">Save</Button>
                    <Button variant="ghost" size="sm" onClick={() => setIsEditingName(false)} className="h-10">Cancel</Button>
                 </div>
               ) : (
                 <div className="flex items-center gap-3 mb-3 group">
                   <h1 className="text-2xl font-bold text-white tracking-tight">{collection.name}</h1>
                   <button onClick={() => { setNameInput(collection.name); setIsEditingName(true); }} className="text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-slate-800">
                     <Edit2 size={16} />
                   </button>
                 </div>
               )}

               <div className="flex items-center gap-3">
                 {collection.customerName ? (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold uppercase tracking-wider">
                      <User size={12} />
                      <Link href={`/customers/${collection.printavoCustomerId}`} className="hover:underline">{collection.customerName}</Link>
                    </div>
                 ) : (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs font-bold uppercase tracking-wider">
                      <User size={12} />
                      Unlinked
                    </div>
                 )}
                 <CustomerPicker 
                   value={collection.printavoCustomerId} 
                   onSelect={(customerId) => updateMut.mutate({ id, data: { printavoCustomerId: customerId } })} 
                 />
               </div>
            </div>
            
            <div className="w-full md:w-80">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Collection Notes</label>
              <Textarea 
                 value={notesInput} 
                 onChange={e => setNotesInput(e.target.value)} 
                 onBlur={handleNotesBlur}
                 placeholder="Add general notes for this collection..."
                 className="text-sm bg-slate-900 border-slate-800 min-h-[90px] focus-visible:ring-emerald-500/50"
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 md:p-8 custom-scrollbar bg-slate-950">
           <div className="mb-6 flex items-center justify-between max-w-5xl mx-auto">
              <h2 className="text-sm font-semibold text-slate-300">Saved Items ({collection.items.length})</h2>
              <Link href="/product-finder">
                <Button variant="outline" size="sm" className="h-9 text-xs bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20">
                  <Search size={14} className="mr-2" /> Find More Styles
                </Button>
              </Link>
           </div>
           
           {collection.items.length === 0 ? (
              <div className="py-24 flex flex-col items-center justify-center text-center bg-slate-900/30 border border-slate-800 border-dashed rounded-2xl max-w-5xl mx-auto">
                 <div className="w-16 h-16 bg-slate-800/50 rounded-2xl flex items-center justify-center mb-5 border border-slate-800">
                   <Search className="w-8 h-8 text-slate-500" />
                 </div>
                 <h3 className="text-lg font-bold text-white mb-2">Collection is empty</h3>
                 <p className="text-slate-400 max-w-sm text-sm mb-6 leading-relaxed">
                   Browse the catalog and save styles to this collection to start building a quote.
                 </p>
                 <Link href="/product-finder">
                   <Button className="bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/10">
                     Go to Product Finder
                   </Button>
                 </Link>
              </div>
           ) : (
              <div className="space-y-6 max-w-5xl mx-auto">
                 {collection.items.map(item => (
                   <ItemCard key={item.id} item={item} collectionId={collection.id} />
                 ))}
              </div>
           )}
        </div>
      </div>
    </AppShell>
  );
}