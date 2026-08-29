import { useState, useEffect, useMemo } from "react";
import {
  useGetCustomerArtwork,
  getGetCustomerArtworkQueryKey,
  useLinkCustomerArtworkFolder,
  useUnlinkCustomerArtworkFolder,
  useBrowseCustomerArtwork,
  getBrowseCustomerArtworkQueryKey,
  useSearchCustomerArtwork,
  getSearchCustomerArtworkQueryKey,
  useCreateCustomerArtworkBookmark,
  useUpdateCustomerArtworkBookmark,
  useDeleteCustomerArtworkBookmark,
  usePickCustomerArtworkFolder,
  getPickCustomerArtworkFolderQueryKey,
  ArtworkBookmark,
  DropboxEntry
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useStaff } from "@/components/auth/StaffGate";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Folder, Image as ImageIcon, Link as LinkIcon, Unlink, Search, Star, Archive, Edit2, Loader2, File, ChevronRight, Trash2, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";

function alphabetizeDropboxEntries(entries: DropboxEntry[]): DropboxEntry[] {
  return [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) ||
    a.id.localeCompare(b.id),
  );
}

function artworkOpenUrl(customerId: string, locator: string): string {
  return `/api/customers/${encodeURIComponent(customerId)}/artwork/temporary-link?locator=${encodeURIComponent(locator)}&redirect=true`;
}

function artworkPreviewUrl(customerId: string, locator: string): string {
  return `/api/customers/${encodeURIComponent(customerId)}/artwork/temporary-link?locator=${encodeURIComponent(locator)}&inline=true`;
}

function canPreviewArtwork(name: string): boolean {
  return /\.(?:gif|jpe?g|pdf|png|webp)$/i.test(name);
}

function ArtworkPreviewDialog({ customerId, entryName, locator, open, onOpenChange }: {
  customerId: string;
  entryName: string;
  locator: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const previewUrl = artworkPreviewUrl(customerId, locator);
  const originalUrl = artworkOpenUrl(customerId, locator);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[88vh] bg-slate-950 border-slate-800 flex flex-col p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-slate-800">
          <DialogTitle className="text-sm text-slate-200 break-all pr-8">{entryName}</DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Previewing the original file from the linked Dropbox folder.
          </DialogDescription>
        </DialogHeader>
        <iframe
          src={previewUrl}
          title={`Preview ${entryName}`}
          className="w-full flex-1 min-h-0 bg-white"
          data-testid="dropbox-file-preview-frame"
        />
        <div className="px-4 py-3 border-t border-slate-800 flex justify-end">
          <Button asChild variant="outline" size="sm" className="border-slate-700">
            <a href={originalUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} className="mr-1.5" /> Open original
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerArtworkCard({ customerId }: { customerId: string }) {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = getGetCustomerArtworkQueryKey(customerId);

  const { data: artwork, isLoading } = useGetCustomerArtwork(customerId, {
    query: { enabled: !!customerId, queryKey }
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [bookmarkToEdit, setBookmarkToEdit] = useState<ArtworkBookmark | null>(null);

  const unlinkFolder = useUnlinkCustomerArtworkFolder({
    mutation: {
      onSuccess: () => {
        toast({ title: "Dropbox folder unlinked" });
        qc.invalidateQueries({ queryKey });
      },
      onError: (e: any) => toast({ title: "Failed to unlink", description: e.error, variant: "destructive" })
    }
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 flex items-center justify-center">
        <div className="animate-pulse w-full h-32 bg-slate-800/50 rounded-lg"></div>
      </div>
    );
  }

  if (!artwork) return null;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden flex flex-col h-full">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
        <h2 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-2">
          <Folder size={16} className="text-purple-400" />
          Artwork & Logos
        </h2>
        {artwork.linked ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setBrowserOpen(true)} className="h-7 text-xs border-slate-700 bg-slate-900 hover:bg-slate-800">
              <Search size={14} className="mr-1.5" /> Browse Folder
            </Button>
            {isAdmin && (
              <Button variant="ghost" size="sm" onClick={() => {
                if (confirm("Are you sure you want to unlink this customer's Dropbox folder?")) {
                  unlinkFolder.mutate({ id: customerId });
                }
              }} className="h-7 px-2 text-slate-500 hover:text-red-400" title="Unlink Dropbox folder">
                <Unlink size={14} />
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <div className="p-5 flex-1 flex flex-col">
        {!artwork.linked ? (
          <div className="flex flex-col items-center justify-center py-8 text-center flex-1">
            <div className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center mb-3">
              <LinkIcon size={20} className="text-slate-500" />
            </div>
            <h3 className="text-sm font-medium text-slate-200 mb-1">No Dropbox Folder</h3>
            <p className="text-xs text-slate-500 max-w-[250px] mb-4">
              Link a Dropbox folder to manage artwork for this customer.
            </p>
            {isAdmin ? (
              <Button 
                onClick={() => setPickerOpen(true)}
                className="bg-purple-600 hover:bg-purple-500 text-white"
              >
                Choose Folder
              </Button>
            ) : (
              <p className="text-[11px] text-slate-500 italic bg-slate-800/50 px-3 py-1.5 rounded">Only admins can link folders.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {artwork.bookmarks && artwork.bookmarks.length > 0 ? (
              <div className="space-y-2">
                {artwork.bookmarks.map((b: ArtworkBookmark) => (
                  <BookmarkRow key={b.id} bookmark={b} customerId={customerId} isAdmin={isAdmin} onEdit={() => setBookmarkToEdit(b)} />
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-slate-500 text-sm flex flex-col items-center">
                <div className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center mb-3">
                  <Archive size={20} className="text-slate-500" />
                </div>
                No bookmarked artwork. <br/>Browse the folder to add some.
              </div>
            )}
          </div>
        )}
      </div>

      {isAdmin && !artwork.linked && (
        <FolderPicker 
          customerId={customerId} 
          open={pickerOpen} 
          onOpenChange={setPickerOpen} 
        />
      )}

      {artwork.linked && (
        <CustomerArtworkBrowserDialog 
          customerId={customerId} 
          open={browserOpen} 
          onOpenChange={setBrowserOpen}
          bookmarks={artwork.bookmarks}
          isAdmin={isAdmin}
          rootPath={artwork.folder?.pathLower || ""}
        />
      )}
      
      {isAdmin && bookmarkToEdit && (
        <ArtworkBookmarkDialog
          customerId={customerId}
          bookmark={bookmarkToEdit}
          open={!!bookmarkToEdit}
          onOpenChange={(op: boolean) => !op && setBookmarkToEdit(null)}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Subcomponents
// ----------------------------------------------------------------------

function FolderPicker({ customerId, open, onOpenChange }: { customerId: string, open: boolean, onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [currentPath, setCurrentPath] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [folderSearch, setFolderSearch] = useState("");
  const [debouncedFolderSearch, setDebouncedFolderSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<{ path: string, folders: DropboxEntry[] }>({ path: "", folders: [] });
  
  // Reset when opened
  useEffect(() => {
    if (open) {
      setCurrentPath("");
      setManualPath("");
      setFolderSearch("");
      setDebouncedFolderSearch("");
      setCursor(undefined);
      setAccumulated({ path: "", folders: [] });
    }
  }, [open]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedFolderSearch(folderSearch.trim());
      setCursor(undefined);
    }, 350);
    return () => clearTimeout(timeout);
  }, [folderSearch]);

  const { data, isFetching } = usePickCustomerArtworkFolder(
    customerId, 
    debouncedFolderSearch
      ? { q: debouncedFolderSearch }
      : { path: currentPath || undefined, cursor },
    { query: { enabled: open, queryKey: getPickCustomerArtworkFolderQueryKey(customerId, debouncedFolderSearch
      ? { q: debouncedFolderSearch }
      : { path: currentPath || undefined, cursor }) } }
  );

  useEffect(() => {
    if (!debouncedFolderSearch && data?.folders) {
      setAccumulated(prev => {
        if (prev.path !== currentPath) return { path: currentPath, folders: data.folders };
        if (!cursor) return { path: currentPath, folders: data.folders };
        const existingIds = new Set(prev.folders.map(f => f.id));
        const newFolders = data.folders.filter(f => !existingIds.has(f.id));
        return { path: currentPath, folders: [...prev.folders, ...newFolders] };
      });
    }
  }, [data, currentPath, cursor, debouncedFolderSearch]);

  const linkFolder = useLinkCustomerArtworkFolder({
    mutation: {
      onSuccess: () => {
        toast({ title: "Dropbox folder linked" });
        qc.invalidateQueries({ queryKey: getGetCustomerArtworkQueryKey(customerId) });
        onOpenChange(false);
      },
      onError: (e: any) => toast({ title: "Failed to link", description: e.error || "Error linking folder.", variant: "destructive" })
    }
  });

  const handleLink = (path: string) => {
    linkFolder.mutate({ id: customerId, data: { path } });
  };

  const visibleFolders = useMemo(() => {
    return alphabetizeDropboxEntries(debouncedFolderSearch ? (data?.folders || []) : accumulated.folders);
  }, [accumulated.folders, data?.folders, debouncedFolderSearch]);

  const parts = currentPath.split("/").filter(Boolean);
  const handleNav = (index: number) => {
    let newPath = "";
    if (index !== -1) {
      newPath = "/" + parts.slice(0, index + 1).join("/");
    }
    if (newPath !== currentPath) {
      setCurrentPath(newPath);
      setCursor(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-slate-950 border-slate-800 flex flex-col max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="p-4 pb-2 border-b border-slate-800">
          <DialogTitle className="text-slate-200">Link Dropbox Folder</DialogTitle>
          <DialogDescription className="text-slate-400 text-sm">
            Navigate to the customer's folder and select it to link.
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/50">
          <div className="flex-1 flex items-center gap-1 text-sm overflow-x-auto text-slate-400 whitespace-nowrap scrollbar-hide font-medium">
            <button onClick={() => handleNav(-1)} className="hover:text-white shrink-0 flex items-center gap-1.5">
              <Folder size={14} className="text-blue-400" /> Root
            </button>
            {parts.map((p, i) => (
              <div key={i} className="flex items-center gap-1 shrink-0">
                <ChevronRight size={14} className="text-slate-600" />
                <button onClick={() => handleNav(i)} className="hover:text-white">{p}</button>
              </div>
            ))}
          </div>
          {currentPath && (
            <Button size="sm" onClick={() => handleLink(currentPath)} disabled={linkFolder.isPending} className="shrink-0 h-8 bg-purple-600 hover:bg-purple-500 text-white">
              {linkFolder.isPending ? <Loader2 size={14} className="animate-spin" /> : "Link This Folder"}
            </Button>
          )}
        </div>

        <div className="px-4 py-3 border-b border-slate-800">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={folderSearch}
              onChange={(event) => setFolderSearch(event.target.value)}
              placeholder="Search all Dropbox folders..."
              aria-label="Search all Dropbox folders"
              data-testid="input-filter-dropbox-folders"
              className="h-9 pl-9 bg-slate-900 border-slate-700"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 min-h-[300px]">
          {(isFetching || folderSearch.trim() !== debouncedFolderSearch) && visibleFolders.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-slate-500">
              <Loader2 size={18} className="animate-spin mr-2" /> {folderSearch.trim() ? "Searching Dropbox..." : "Loading..."}
            </div>
          ) : !debouncedFolderSearch && accumulated.folders.length === 0 ? (
            <div className="text-center py-20 text-slate-500 text-sm">
              No subfolders found here.
            </div>
          ) : visibleFolders.length === 0 ? (
            <div className="text-center py-20 text-slate-500 text-sm">
              No Dropbox folders match “{debouncedFolderSearch}”.
            </div>
          ) : (
            <div className="space-y-0.5">
              {visibleFolders.map(folder => (
                <div 
                  key={folder.id} 
                  className="flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-slate-800/60 cursor-pointer group transition-colors"
                  onClick={() => {
                    setCurrentPath(folder.pathLower || "");
                    setFolderSearch("");
                    setDebouncedFolderSearch("");
                  }}
                >
                  <Folder size={16} className="text-blue-400 fill-blue-400/20 shrink-0" />
                  <p className="text-sm truncate text-slate-200 font-medium flex-1">{folder.name}</p>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={(e) => { e.stopPropagation(); handleLink(folder.pathLower || ""); }}
                    className="opacity-0 group-hover:opacity-100 h-7 px-2 text-xs border border-slate-700 bg-slate-900"
                  >
                    Link
                  </Button>
                </div>
              ))}
              {!debouncedFolderSearch && data?.truncated && data?.cursor && (
                <div className="pt-2 pb-1 text-center">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setCursor(data.cursor!)} 
                    disabled={isFetching}
                    className="text-xs text-slate-400 border-slate-700 bg-slate-900"
                  >
                    {isFetching ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null}
                    Load More Folders
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        
        <div className="p-4 border-t border-slate-800 bg-slate-900/50">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Or enter path manually</p>
          <div className="flex items-center gap-2">
            <Input 
              value={manualPath} 
              onChange={e => setManualPath(e.target.value)} 
              placeholder="/Customers/Acme Corp" 
              className="h-8 text-sm bg-slate-950 border-slate-800"
            />
            <Button size="sm" onClick={() => handleLink(manualPath)} disabled={!manualPath || linkFolder.isPending} className="h-8 bg-slate-800 hover:bg-slate-700 text-white shrink-0">
              Link
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BookmarkRow({ bookmark, customerId, isAdmin, onEdit }: { bookmark: ArtworkBookmark, customerId: string, isAdmin: boolean, onEdit: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreview = canPreviewArtwork(bookmark.name);
  const invoiceMatch = bookmark.name.match(/(?:inv|invoice)?[ -_]?#?(\d{4,6})/i);
  const invoiceNum = invoiceMatch ? invoiceMatch[1] : null;

  return (
    <>
      <div className={`flex items-start gap-3 p-3 rounded-lg border bg-slate-800/30 group transition-colors hover:bg-slate-800/50 ${bookmark.retired ? 'border-slate-800/50 opacity-60' : bookmark.preferred ? 'border-purple-500/30 bg-purple-950/10' : 'border-slate-800'}`}>
      <div className="shrink-0 pt-0.5">
        {bookmark.retired ? <Archive size={16} className="text-slate-500" /> : <ImageIcon size={16} className={bookmark.preferred ? "text-purple-400" : "text-slate-400"} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-medium text-slate-200 whitespace-normal break-all">{bookmark.label}</p>
          {bookmark.preferred && <Star size={12} className="text-yellow-500 fill-yellow-500" />}
          {bookmark.retired && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-medium tracking-wide uppercase">Retired</span>}
        </div>
        <p className="text-xs text-slate-500 whitespace-normal break-all" title={bookmark.name}>
          {bookmark.name} 
          {invoiceNum && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-800/50 uppercase tracking-wider">inv #{invoiceNum}</span>}
        </p>
        {bookmark.notes && (
          <p className="text-xs text-slate-300 mt-2 bg-slate-900/60 p-2 rounded border border-slate-800/50 leading-relaxed whitespace-pre-wrap">{bookmark.notes}</p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {canPreview ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-slate-300 hover:text-white"
            onClick={() => setPreviewOpen(true)}
            aria-label={`Preview ${bookmark.name}`}
          >
            <ExternalLink size={14} className="sm:mr-1.5" />
            <span className="hidden sm:inline">Preview</span>
          </Button>
        ) : (
          <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-slate-300 hover:text-white">
            <a
              href={artworkOpenUrl(customerId, bookmark.pathLower || bookmark.dropboxId || "")}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${bookmark.name}`}
            >
              <ExternalLink size={14} className="sm:mr-1.5" />
              <span className="hidden sm:inline">Open</span>
            </a>
          </Button>
        )}
        {isAdmin && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-400 hover:text-white" onClick={onEdit}>
            <Edit2 size={14} />
          </Button>
        )}
      </div>
      </div>
      {canPreview && (
        <ArtworkPreviewDialog
          customerId={customerId}
          entryName={bookmark.name}
          locator={bookmark.pathLower || bookmark.dropboxId || ""}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      )}
    </>
  );
}

function CustomerArtworkBrowserDialog({ customerId, open, onOpenChange, bookmarks, isAdmin, rootPath }: { customerId: string, open: boolean, onOpenChange: (open: boolean) => void, bookmarks: ArtworkBookmark[], isAdmin: boolean, rootPath: string }) {
  // Navigation state is relative to the rootPath (i.e. starts exactly at rootPath).
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [searchQ, setSearchQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<{ path: string, entries: DropboxEntry[] }>({ path: rootPath, entries: [] });
  
  useEffect(() => {
    const t = setTimeout(() => {
      const newQ = searchQ.trim();
      if (newQ !== debouncedQ) {
        setDebouncedQ(newQ);
        setCursor(undefined);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [searchQ, debouncedQ]);

  // Reset navigation when modal opens
  useEffect(() => {
    if (open) {
      setCurrentPath(rootPath);
      setSearchQ("");
      setDebouncedQ("");
      setCursor(undefined);
      setAccumulated({ path: rootPath, entries: [] });
    }
  }, [open, rootPath]);

  const { data: browseData, isFetching: isBrowsing } = useBrowseCustomerArtwork(
    customerId, 
    { path: currentPath || undefined, cursor }, 
    { query: { enabled: open && debouncedQ === "", queryKey: getBrowseCustomerArtworkQueryKey(customerId, { path: currentPath || undefined, cursor }) } }
  );

  const { data: searchData, isFetching: isSearching } = useSearchCustomerArtwork(
    customerId, 
    { q: debouncedQ }, 
    { query: { enabled: open && debouncedQ !== "", queryKey: getSearchCustomerArtworkQueryKey(customerId, { q: debouncedQ }) } }
  );

  useEffect(() => {
    if (debouncedQ === "" && browseData?.entries) {
      setAccumulated(prev => {
        if (prev.path !== currentPath) return { path: currentPath, entries: browseData.entries };
        if (!cursor) return { path: currentPath, entries: browseData.entries };
        const existingIds = new Set(prev.entries.map(e => e.id));
        const newEntries = browseData.entries.filter(e => !existingIds.has(e.id));
        return { path: currentPath, entries: [...prev.entries, ...newEntries] };
      });
    }
  }, [browseData, currentPath, debouncedQ, cursor]);

  const entries = useMemo(
    () => alphabetizeDropboxEntries(debouncedQ ? (searchData?.entries || []) : accumulated.entries),
    [accumulated.entries, debouncedQ, searchData?.entries],
  );
  const isLoading = isBrowsing || isSearching;

  // Breadcrumbs: only show parts that are beyond the rootPath.
  const rootParts = (rootPath || "").split("/").filter(Boolean);
  const currentParts = (currentPath || "").split("/").filter(Boolean);
  // Ensure we don't slice negatively if something went wrong, but currentParts should always have rootParts as prefix.
  const relativeParts = currentParts.slice(rootParts.length);
  
  const handleNav = (index: number) => {
    let newPath = rootPath;
    if (index !== -1) {
      const selectedParts = [...rootParts, ...relativeParts.slice(0, index + 1)];
      newPath = "/" + selectedParts.join("/");
    }
    if (newPath !== currentPath) {
      setCurrentPath(newPath);
      setCursor(undefined);
    }
  };

  const handleEntryNav = (pathLower: string) => {
    setCurrentPath(pathLower);
    setSearchQ("");
    setDebouncedQ("");
    setCursor(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-slate-950 border-slate-800 flex flex-col max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-slate-200">Browse Artwork</DialogTitle>
        </DialogHeader>
        
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/50">
          <div className="flex-1 flex items-center gap-1 text-sm overflow-x-auto text-slate-400 whitespace-nowrap scrollbar-hide font-medium">
            <button onClick={() => handleNav(-1)} className="hover:text-white shrink-0 flex items-center gap-1.5">
              <Folder size={14} className="text-blue-400" /> Root
            </button>
            {relativeParts.map((p: string, i: number) => (
              <div key={i} className="flex items-center gap-1 shrink-0">
                <ChevronRight size={14} className="text-slate-600" />
                <button onClick={() => handleNav(i)} className="hover:text-white">{p}</button>
              </div>
            ))}
          </div>
          <div className="relative w-56 shrink-0">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input 
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search in folder..." 
              className="h-8 pl-8 text-xs bg-slate-900 border-slate-700"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 min-h-[400px]">
          {isBrowsing && accumulated.entries.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-slate-500">
              <Loader2 size={18} className="animate-spin mr-2" /> Loading...
            </div>
          ) : isSearching && entries.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-slate-500">
              <Loader2 size={18} className="animate-spin mr-2" /> Searching...
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center py-20 text-slate-500 text-sm">
              {debouncedQ ? "No matching files found." : "This folder is empty."}
            </div>
          ) : (
            <div className="space-y-0.5">
              {entries.map((entry: DropboxEntry) => (
                <EntryRow 
                  key={entry.id} 
                  entry={entry} 
                  customerId={customerId} 
                  isAdmin={isAdmin}
                  onNavigate={() => handleEntryNav(entry.pathLower || "")}
                  isBookmarked={bookmarks?.some((b: ArtworkBookmark) => b.pathLower === entry.pathLower || b.dropboxId === entry.id)}
                />
              ))}
              
              {!debouncedQ && browseData?.truncated && browseData?.cursor && (
                <div className="pt-2 pb-1 text-center">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setCursor(browseData.cursor!)} 
                    disabled={isBrowsing}
                    className="text-xs text-slate-400 border-slate-700 bg-slate-900"
                  >
                    {isBrowsing ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null}
                    Load More Items
                  </Button>
                </div>
              )}

              {debouncedQ && searchData?.truncated && (
                <div className="mt-4 p-3 text-center rounded-lg bg-orange-950/20 border border-orange-900/30">
                  <p className="text-xs text-orange-400">
                    Only the first 50 matches are shown. Please refine your search to see more.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EntryRow({ entry, customerId, onNavigate, isBookmarked, isAdmin }: { entry: DropboxEntry, customerId: string, onNavigate: () => void, isBookmarked: boolean, isAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreview = canPreviewArtwork(entry.name);

  const createBookmark = useCreateCustomerArtworkBookmark({
    mutation: {
      onSuccess: () => {
        toast({ title: "Bookmark added" });
        qc.invalidateQueries({ queryKey: getGetCustomerArtworkQueryKey(customerId) });
      },
      onError: (e: any) => toast({ title: "Failed to bookmark", description: e.error || "Error", variant: "destructive" }),
      onSettled: () => setAdding(false)
    }
  });

  const handleAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    setAdding(true);
    createBookmark.mutate({
      id: customerId,
      data: {
        path: entry.pathLower || entry.id, // backend handles resolution
        label: entry.name.replace(/\.[^/.]+$/, ""), // strip extension for default label
      }
    });
  };

  const isFolder = entry.type === "folder";
  const invoiceMatch = !isFolder && entry.name.match(/(?:inv|invoice)?[ -_]?#?(\d{4,6})/i);
  const invoiceNum = invoiceMatch ? invoiceMatch[1] : null;

  return (
    <>
      <div
      className={`flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-slate-800/60 group transition-colors ${isFolder ? "cursor-pointer" : ""}`}
      onClick={isFolder ? onNavigate : undefined}
    >
      <div className="shrink-0 pt-0.5">
        {isFolder ? <Folder size={16} className="text-blue-400 fill-blue-400/20" /> : <File size={16} className="text-slate-400" />}
      </div>
      <div className="min-w-0 flex-1 flex items-start gap-2">
        <p
          className={`text-sm leading-5 whitespace-normal break-all ${isFolder ? "text-blue-100 font-medium" : "text-slate-300"}`}
          title={entry.name}
          data-testid={`dropbox-entry-name-${entry.id}`}
        >
          {entry.name}
        </p>
        {invoiceNum && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-800/50 uppercase tracking-wider shrink-0">inv #{invoiceNum}</span>}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {!isFolder && (
          <>
            {canPreview ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-slate-300 hover:text-white bg-slate-800/70"
                onClick={(event) => {
                  event.stopPropagation();
                  setPreviewOpen(true);
                }}
                title={`Preview ${entry.name}`}
                data-testid={`button-preview-dropbox-file-${entry.id}`}
                aria-label={`Preview ${entry.name}`}
              >
                <ExternalLink size={14} className="sm:mr-1.5" />
                <span className="hidden sm:inline">Preview</span>
              </Button>
            ) : (
              <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-slate-300 hover:text-white bg-slate-800/70">
                <a
                  href={artworkOpenUrl(customerId, entry.pathLower || entry.id || "")}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`Open ${entry.name}`}
                >
                  <ExternalLink size={14} className="sm:mr-1.5" />
                  <span className="hidden sm:inline">Open</span>
                </a>
              </Button>
            )}
            {isAdmin && (
              <Button 
                variant="ghost" 
                size="icon" 
                className={`h-8 w-8 bg-slate-800/70 ${isBookmarked ? "text-yellow-400" : "text-slate-300 hover:text-yellow-400 hover:bg-yellow-900/30"}`}
                onClick={handleAdd} 
                disabled={adding || isBookmarked}
                title={isBookmarked ? "Already pinned" : `Pin ${entry.name}`}
                aria-label={isBookmarked ? `${entry.name} is pinned` : `Pin ${entry.name}`}
                data-testid={`button-pin-dropbox-file-${entry.id}`}
              >
                {adding ? <Loader2 size={14} className="animate-spin" /> : <Star size={15} className={isBookmarked ? "fill-yellow-400" : ""} />}
              </Button>
            )}
          </>
        )}
      </div>
      </div>
      {!isFolder && canPreview && (
        <ArtworkPreviewDialog
          customerId={customerId}
          entryName={entry.name}
          locator={entry.pathLower || entry.id || ""}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      )}
    </>
  );
}

function ArtworkBookmarkDialog({ customerId, bookmark, open, onOpenChange }: { customerId: string, bookmark: ArtworkBookmark, open: boolean, onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  
  const [label, setLabel] = useState(bookmark.label || "");
  const [notes, setNotes] = useState(bookmark.notes || "");
  const [preferred, setPreferred] = useState(bookmark.preferred || false);
  const [retired, setRetired] = useState(bookmark.retired || false);

  useEffect(() => {
    if (open) {
      setLabel(bookmark.label || "");
      setNotes(bookmark.notes || "");
      setPreferred(bookmark.preferred || false);
      setRetired(bookmark.retired || false);
    }
  }, [open, bookmark]);

  const updateBookmark = useUpdateCustomerArtworkBookmark({
    mutation: {
      onSuccess: () => {
        toast({ title: "Bookmark updated" });
        qc.invalidateQueries({ queryKey: getGetCustomerArtworkQueryKey(customerId) });
        onOpenChange(false);
      },
      onError: (e: any) => toast({ title: "Failed to update", description: e.error, variant: "destructive" })
    }
  });

  const deleteBookmark = useDeleteCustomerArtworkBookmark({
    mutation: {
      onSuccess: () => {
        toast({ title: "Bookmark removed" });
        qc.invalidateQueries({ queryKey: getGetCustomerArtworkQueryKey(customerId) });
        onOpenChange(false);
      }
    }
  });

  const handleSave = () => {
    updateBookmark.mutate({
      id: customerId,
      bookmarkId: bookmark.id,
      data: {
        label,
        notes: notes || null,
        preferred,
        retired
      }
    });
  };

  const handleDelete = () => {
    if (confirm("Remove this bookmark?")) {
      deleteBookmark.mutate({ id: customerId, bookmarkId: bookmark.id });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-slate-950 border-slate-800">
        <DialogHeader>
          <DialogTitle className="text-slate-200">Edit Bookmark</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-5 py-4">
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">Display Label</label>
            <Input value={label} onChange={e => setLabel(e.target.value)} className="h-9 text-sm bg-slate-900 border-slate-700" />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">Notes & Usage</label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="text-sm min-h-[80px] bg-slate-900 border-slate-700" placeholder="e.g. Only for dark backgrounds" />
          </div>
          <div className="flex items-center gap-6 p-3 rounded-lg bg-slate-900/50 border border-slate-800">
            <label className="flex items-center gap-2.5 text-sm font-medium text-slate-300 cursor-pointer">
              <Checkbox checked={preferred} onCheckedChange={(c) => setPreferred(!!c)} className="border-slate-600 data-[state=checked]:bg-purple-600 data-[state=checked]:border-purple-600" />
              Staple Logo
            </label>
            <label className="flex items-center gap-2.5 text-sm font-medium text-slate-300 cursor-pointer">
              <Checkbox checked={retired} onCheckedChange={(c) => setRetired(!!c)} className="border-slate-600" />
              Retired
            </label>
          </div>
          <div className="text-[11px] text-slate-500 bg-slate-900/50 p-3 rounded-lg border border-slate-800 break-all flex flex-col gap-1">
            <span className="font-semibold uppercase tracking-wider text-slate-600">File Path</span>
            {bookmark.pathDisplay}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between border-t border-slate-800 pt-4 mt-2">
          <Button variant="ghost" size="sm" onClick={handleDelete} className="text-red-400 hover:text-red-300 hover:bg-red-400/10">
            <Trash2 size={14} className="mr-1.5" /> Remove
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="text-slate-300">Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={updateBookmark.isPending} className="bg-blue-600 hover:bg-blue-500 text-white">
              {updateBookmark.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />} Save Changes
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
