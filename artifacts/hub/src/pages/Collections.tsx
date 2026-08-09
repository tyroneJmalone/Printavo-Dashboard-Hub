import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Star, Plus, Folder, Clock, User, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import {
  useListCollections,
  getListCollectionsQueryKey,
  useCreateCollection,
  useDeleteCollection
} from "@workspace/api-client-react";

export default function Collections() {
  const [q, setQ] = useState("");
  const { data, isLoading } = useListCollections(undefined, {
    query: { queryKey: getListCollectionsQueryKey() }
  });
  
  const collections = data?.collections ?? [];
  const filtered = collections.filter(c => 
    c.name.toLowerCase().includes(q.toLowerCase()) || 
    (c.customerName && c.customerName.toLowerCase().includes(q.toLowerCase()))
  );

  const qc = useQueryClient();
  const { toast } = useToast();

  const createMut = useCreateCollection({
    mutation: {
      onSuccess: () => {
        toast({ title: "Collection created" });
        qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
      },
      onError: (err) => toast({ title: "Failed to create", description: String(err), variant: "destructive" })
    }
  });

  const deleteMut = useDeleteCollection({
    mutation: {
      onSuccess: () => {
        toast({ title: "Collection deleted" });
        qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
      },
      onError: (err) => toast({ title: "Failed to delete", description: String(err), variant: "destructive" })
    }
  });

  const handleCreate = () => {
    const name = window.prompt("Collection name:");
    if (name && name.trim()) {
      createMut.mutate({ data: { name: name.trim() } });
    }
  };

  const handleDelete = (e: React.MouseEvent, id: string, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.confirm(`Delete collection "${name}"?`)) {
      deleteMut.mutate({ id });
    }
  };

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <Star className="text-[#10b981]" size={24} />
                Collections
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                Save styles, colors, and notes while researching for clients.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4" />
                <Input 
                  placeholder="Search collections..." 
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  className="pl-9 h-9 bg-slate-900 border-slate-700"
                />
              </div>
              <Button onClick={handleCreate} disabled={createMut.isPending} className="h-9 bg-[#059669] hover:bg-[#047857] text-white text-xs px-4">
                {createMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                New Collection
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {isLoading ? (
             <div className="py-20 flex justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-[#10b981]" />
             </div>
          ) : collections.length === 0 ? (
             <div className="py-20 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-slate-800/50 rounded-2xl flex items-center justify-center mb-4 border border-slate-800">
                  <Folder className="w-8 h-8 text-slate-500" />
                </div>
                <h3 className="text-lg font-bold text-white mb-2">No collections yet</h3>
                <p className="text-slate-400 max-w-sm text-sm mb-6">
                  Save styles directly from the Product Finder to a collection, then attach them to a customer.
                </p>
                <Button onClick={handleCreate} className="bg-[#059669] hover:bg-[#047857] text-white">
                  Create Collection
                </Button>
             </div>
          ) : filtered.length === 0 ? (
             <div className="py-20 text-center text-slate-500">
                No collections match your search.
             </div>
          ) : (
             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
               {filtered.map(c => (
                 <Link key={c.id} href={`/collections/${c.id}`}>
                   <div className="bg-slate-900/60 border border-slate-800 hover:border-slate-600 rounded-xl overflow-hidden transition-all group cursor-pointer h-full flex flex-col">
                     <div className="p-4 flex-1">
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <h3 className="font-bold text-white text-lg truncate" title={c.name}>{c.name}</h3>
                          <button 
                            onClick={(e) => handleDelete(e, c.id, c.name)}
                            className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                             <Trash2 size={14} />
                          </button>
                        </div>
                        {c.customerName && (
                           <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold uppercase mb-3 truncate max-w-full">
                             <User size={10} className="flex-shrink-0" />
                             <span className="truncate">{c.customerName}</span>
                           </div>
                        )}
                        <div className="text-xs font-medium text-slate-400 mb-4">
                           {c.itemCount} item{c.itemCount !== 1 && 's'}
                        </div>
                        
                        {c.previewImages.length > 0 && (
                          <div className="flex gap-2">
                             {c.previewImages.map((img, i) => (
                               <div key={i} className="w-12 h-12 rounded bg-white/5 border border-white/10 flex items-center justify-center p-1">
                                 <img src={img} className="max-w-full max-h-full object-contain mix-blend-screen" alt="" />
                               </div>
                             ))}
                          </div>
                        )}
                     </div>
                     <div className="px-4 py-3 bg-slate-950 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 truncate">
                           <User size={12} /> {c.createdByEmail || 'Unknown'}
                        </div>
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                           <Clock size={12} /> {formatDistanceToNow(new Date(c.updatedAt))} ago
                        </div>
                     </div>
                   </div>
                 </Link>
               ))}
             </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
