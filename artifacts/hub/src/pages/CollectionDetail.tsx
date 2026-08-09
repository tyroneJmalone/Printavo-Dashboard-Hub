import { useState, useEffect, useRef } from "react";
import { useParams, Link, useLocation } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Loader2, ArrowLeft, User, MapPin, Edit2, Check, X, Search, AlertTriangle, Link as LinkIcon, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useGetCollection,
  getGetCollectionQueryKey,
  useUpdateCollection,
  useUpdateCollectionItem,
  useRemoveCollectionItem,
  useListDirectoryCustomers,
  getListDirectoryCustomersQueryKey,
  type CollectionItemDetail
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

  const imgUrl = item.vendor === 'ss' && item.styleImage && !item.styleImage.startsWith('http') 
    ? (item.styleImage.startsWith('/') ? `https://www.ssactivewear.com${item.styleImage}` : `https://www.ssactivewear.com/${item.styleImage}`)
    : item.styleImage;

  const cost = item.priceMax ?? item.priceMin ?? 0;
  const label = `${item.brand || ""} ${item.title || item.styleName}`.trim();

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row gap-5">
       <div className="w-full md:w-32 h-32 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center p-2 flex-shrink-0 relative">
          {imgUrl ? (
             <img src={imgUrl} className="max-w-full max-h-full object-contain mix-blend-screen" alt="" />
          ) : (
             <span className="text-xs text-slate-500">No Image</span>
          )}
          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-slate-950/80 border border-slate-800 text-[9px] font-bold text-slate-300 uppercase tracking-wider backdrop-blur-sm">
             {item.vendor}
          </div>
       </div>

       <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex justify-between items-start gap-4 mb-2">
             <div>
                <div className="flex items-center gap-2 mb-1">
                   <h3 className="font-bold text-white text-lg">{item.styleName}</h3>
                   {item.brand && <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{item.brand}</span>}
                </div>
                <div className="text-sm text-slate-400 truncate max-w-lg">{item.title}</div>
             </div>
             <div className="text-right flex-shrink-0">
                <div className="text-sm font-mono font-bold text-[#10b981]">
                  {item.priceMin != null && item.priceMax != null && item.priceMin !== item.priceMax 
                     ? `$${item.priceMin.toFixed(2)} - $${item.priceMax.toFixed(2)}`
                     : item.priceMin != null ? `$${item.priceMin.toFixed(2)}` : "No price"
                  }
                </div>
                <div className="text-[10px] uppercase text-slate-500 mt-1 font-bold">Cost Range</div>
             </div>
          </div>

          {(item.discontinued || !item.inCatalog) && (
            <div className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 mb-3 w-fit">
               <AlertTriangle size={12} />
               {item.discontinued ? "Discontinued by Vendor" : "Not found in local catalog"}
            </div>
          )}

          {isEditing ? (
             <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-3 mb-4">
                <div>
                   <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Chosen Colors (comma separated)</label>
                   <Input value={colorsStr} onChange={e => setColorsStr(e.target.value)} className="h-8 text-xs bg-slate-900 border-slate-700" placeholder="e.g. Black, Navy, True Red" />
                </div>
                <div>
                   <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Note for this item</label>
                   <Textarea value={noteStr} onChange={e => setNoteStr(e.target.value)} className="text-xs bg-slate-900 border-slate-700 min-h-[60px]" placeholder="Special instructions..." />
                </div>
                <div className="flex gap-2 justify-end">
                   <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); setColorsStr(item.colors.join(", ")); setNoteStr(item.note || ""); }} className="h-7 text-xs">Cancel</Button>
                   <Button size="sm" onClick={handleSave} disabled={updateMut.isPending} className="h-7 text-xs bg-[#059669] hover:bg-[#047857] text-white">Save</Button>
                </div>
             </div>
          ) : (
             <div className="mb-4">
                <div className="flex flex-wrap gap-1.5 mb-2">
                   {item.colors.length > 0 ? (
                      item.colors.map(c => (
                         <span key={c} className="text-[11px] font-medium bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded">{c}</span>
                      ))
                   ) : (
                      <span className="text-xs text-slate-500 italic">No colors selected</span>
                   )}
                </div>
                {item.note && <div className="text-xs text-slate-400 italic bg-slate-800/30 px-3 py-2 rounded border border-slate-800/50">"{item.note}"</div>}
             </div>
          )}

          <div className="mt-auto pt-3 border-t border-slate-800/50 flex flex-wrap items-center justify-between gap-3">
             <div className="flex gap-2">
                {!isEditing && (
                   <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)} className="h-7 text-xs text-slate-400 hover:text-white hover:bg-slate-800">
                     <Edit2 className="w-3 h-3 mr-1.5" /> Edit details
                   </Button>
                )}
                <Button variant="ghost" size="sm" onClick={handleRemove} disabled={removeMut.isPending} className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/30">
                  <Trash2 className="w-3 h-3 mr-1.5" /> Remove
                </Button>
             </div>
             <div className="flex gap-2">
                <Link href={`/product-finder?style=${encodeURIComponent(item.styleName)}`}>
                   <Button variant="outline" size="sm" className="h-7 text-xs bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700">
                     Check live stock
                   </Button>
                </Link>
                <Link href={`/price-calculator?garmentCost=${cost}&label=${encodeURIComponent(label)}`}>
                   <Button variant="outline" size="sm" className="h-7 text-xs bg-[#059669]/10 border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20">
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
          <Loader2 className="w-8 h-8 animate-spin text-[#10b981]" />
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
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-5">
          <div className="mb-4">
            <Link href="/collections" className="inline-flex items-center text-xs font-semibold text-slate-500 hover:text-slate-300 transition-colors">
              <ArrowLeft size={14} className="mr-1" /> Back to Collections
            </Link>
          </div>
          
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
            <div className="flex-1">
               {isEditingName ? (
                 <div className="flex items-center gap-2 mb-2">
                    <Input autoFocus value={nameInput} onChange={e => setNameInput(e.target.value)} className="h-9 bg-slate-900 border-slate-700 text-lg font-bold max-w-sm" />
                    <Button size="sm" onClick={handleNameSave} className="h-9 bg-[#059669] hover:bg-[#047857] text-white">Save</Button>
                    <Button variant="ghost" size="sm" onClick={() => setIsEditingName(false)} className="h-9">Cancel</Button>
                 </div>
               ) : (
                 <div className="flex items-center gap-3 mb-2 group">
                   <h1 className="text-2xl font-bold text-white tracking-tight">{collection.name}</h1>
                   <button onClick={() => { setNameInput(collection.name); setIsEditingName(true); }} className="text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity">
                     <Edit2 size={14} />
                   </button>
                 </div>
               )}

               <div className="flex items-center gap-3">
                 {collection.customerName ? (
                    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold uppercase">
                      <User size={12} />
                      <Link href={`/customers/${collection.printavoCustomerId}`} className="hover:underline">{collection.customerName}</Link>
                    </div>
                 ) : (
                    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs font-bold uppercase">
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
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Collection Notes</label>
              <Textarea 
                 value={notesInput} 
                 onChange={e => setNotesInput(e.target.value)} 
                 onBlur={handleNotesBlur}
                 placeholder="Add general notes for this collection..."
                 className="text-xs bg-slate-900/50 border-slate-800 min-h-[80px]"
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
           <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-300">Saved Items ({collection.items.length})</h2>
              <Link href="/product-finder">
                <Button variant="outline" size="sm" className="h-8 text-xs bg-[#059669]/10 border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20">
                  <Search size={14} className="mr-2" /> Find More Styles
                </Button>
              </Link>
           </div>
           
           {collection.items.length === 0 ? (
              <div className="py-20 flex flex-col items-center justify-center text-center bg-slate-900/30 border border-slate-800 border-dashed rounded-xl">
                 <div className="w-16 h-16 bg-slate-800/50 rounded-2xl flex items-center justify-center mb-4 border border-slate-800">
                   <Search className="w-8 h-8 text-slate-500" />
                 </div>
                 <h3 className="text-lg font-bold text-white mb-2">Collection is empty</h3>
                 <p className="text-slate-400 max-w-sm text-sm mb-6">
                   Browse the catalog and save styles to this collection to start building a quote.
                 </p>
                 <Link href="/product-finder">
                   <Button className="bg-[#059669] hover:bg-[#047857] text-white">
                     Go to Product Finder
                   </Button>
                 </Link>
              </div>
           ) : (
              <div className="space-y-4">
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
