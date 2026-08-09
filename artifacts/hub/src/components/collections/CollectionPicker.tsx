import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Star, Plus, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useListCollections,
  getListCollectionsQueryKey,
  useCreateCollection,
  useAddCollectionItems,
  type NewCollectionItem
} from "@workspace/api-client-react";

export function CollectionPicker({
  items,
  children,
  align = "end"
}: {
  items: NewCollectionItem[];
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: collectionsData } = useListCollections(undefined, {
    query: { queryKey: getListCollectionsQueryKey() }
  });
  const collections = collectionsData?.collections ?? [];

  const addItems = useAddCollectionItems({
    mutation: {
      onSuccess: () => {
        toast({ title: "Saved to collection" });
        qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
        setOpen(false);
      },
      onError: (err) => {
        toast({ title: "Failed to save", description: String(err), variant: "destructive" });
      }
    }
  });

  const createColl = useCreateCollection({
    mutation: {
      onSuccess: () => {
        toast({ title: "Collection created" });
        qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
        setOpen(false);
        setNewName("");
        setIsCreating(false);
      },
      onError: (err) => {
        toast({ title: "Failed to create", description: String(err), variant: "destructive" });
      }
    }
  });

  const handleSaveToExisting = (collectionId: string) => {
    addItems.mutate({ id: collectionId, data: { items } });
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    createColl.mutate({ data: { name: newName.trim(), items } });
  };

  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) {
        setIsCreating(false);
        setNewName("");
      }
    }}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-0 bg-slate-900 border-slate-700 shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {isCreating ? (
          <form onSubmit={handleCreate} className="p-3 bg-slate-800/50 flex flex-col gap-2">
            <Input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Collection name..."
              className="h-8 text-xs bg-slate-950 border-slate-700 text-white"
            />
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" className="flex-1 h-8 text-xs" onClick={() => setIsCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" className="flex-1 h-8 text-xs bg-[#059669] hover:bg-[#047857] text-white" disabled={!newName.trim() || createColl.isPending}>
                {createColl.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Create"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col max-h-[300px]">
            <div className="p-2 border-b border-slate-800">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 h-8"
                onClick={() => setIsCreating(true)}
              >
                <Plus className="w-3 h-3 mr-2" />
                New collection...
              </Button>
            </div>
            <div className="overflow-y-auto p-2 flex flex-col gap-1 custom-scrollbar">
              {collections.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-500">
                  No collections yet
                </div>
              ) : (
                collections.map(c => (
                  <Button
                    key={c.id}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs text-slate-300 hover:text-white hover:bg-slate-800 h-8 font-normal"
                    onClick={() => handleSaveToExisting(c.id)}
                    disabled={addItems.isPending}
                  >
                    <Star className="w-3 h-3 mr-2 text-slate-500" />
                    <span className="truncate">{c.name}</span>
                  </Button>
                ))
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
